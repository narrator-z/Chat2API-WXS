/**
 * Qwen AI risk-control (Aliyun Baxia WAF) captcha helper.
 *
 * When chat.qwen.ai returns the WAF punish payload
 * ({"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::..."],"data":{"url":"...punish..."}})
 * the only way to unblock the session is to solve the slider captcha in a real
 * browser context. This module opens a small BrowserWindow (persistent
 * partition) seeded with the account cookies, loads the punish URL, waits for
 * the user to slide, then harvests the refreshed cookies (including the WAF
 * trust cookies) and persists them back into the account credentials so the
 * pending request can be retried automatically.
 */

import { BrowserWindow, session } from 'electron'
import type { Session, WebFrameMain } from 'electron'
import { AccountManager } from '../store/accounts'
import { normalizeCookies } from '../lib/qwenAiAuth'

const PARTITION = 'persist:qwen-ai-captcha'
const PUNISH_URL_RE = /_____tmd_____|\bpunish\b/

/** One pending captcha window per account to avoid duplicates. */
const pending = new Map<string, Promise<string | null>>()

/**
 * Open the captcha verification window for an account.
 * Resolves with the merged cookie string when the user completed the
 * verification, or null when the window was closed without solving it.
 */
export function openQwenAiCaptchaWindow(accountId: string, punishUrl?: string): Promise<string | null> {
  const existing = pending.get(accountId)
  if (existing) return existing
  const promise = runCaptchaWindow(accountId, punishUrl || '').finally(() => {
    pending.delete(accountId)
  })
  pending.set(accountId, promise)
  return promise
}

async function runCaptchaWindow(accountId: string, punishUrl: string): Promise<string | null> {
  const account = AccountManager.getById(accountId, true)
  if (!account) {
    console.warn('[QwenCaptcha] Account not found:', accountId)
    return null
  }

  const sess = session.fromPartition(PARTITION)
  // Legacy in-app-login accounts may store cookies as a name -> value object;
  // normalize to a Cookie header string before seeding/merging.
  const existingCookies = normalizeCookies(
    (account.credentials as Record<string, unknown>).cookies ??
      (account.credentials as Record<string, unknown>).cookie
  )
  await seedCookies(sess, existingCookies)

  const win = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'Qwen AI 风控验证',
    autoHideMenuBar: true,
    webPreferences: {
      session: sess,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  return new Promise<string | null>((resolve) => {
    let settled = false
    let pollTimer: NodeJS.Timeout | undefined
    let autoSlideRunning = false
    let autoSlideAttempted = false

    const triggerAutoSlide = () => {
      if (autoSlideRunning || settled || win.isDestroyed()) return
      autoSlideRunning = true
      attemptAutoSlide(win)
        .then((ok) => {
          if (!ok && !settled && !win.isDestroyed()) {
            void setBarStatus(win, '自动滑动未通过，请手动完成滑块后点击下方绿色按钮')
          }
        })
        .catch((error) => {
          console.error('[QwenCaptcha] Auto slide error:', error)
        })
        .finally(() => {
          autoSlideRunning = false
        })
    }

    const finish = async (solved: boolean) => {
      if (settled) return
      settled = true
      if (pollTimer) clearInterval(pollTimer)
      let merged: string | null = null
      if (solved) {
        merged = await collectAndMergeCookies(sess, existingCookies)
        if (merged) {
          try {
            AccountManager.update(accountId, {
              credentials: { ...account.credentials, cookies: merged },
            })
            console.log('[QwenCaptcha] Cookies refreshed for account', accountId)
          } catch (error) {
            console.error('[QwenCaptcha] Failed to persist refreshed cookies:', error)
          }
        } else {
          console.warn('[QwenCaptcha] Verification reported solved but no cookies collected')
        }
      }
      if (!win.isDestroyed()) win.close()
      resolve(merged)
    }

    const targetUrl = punishUrl || 'https://chat.qwen.ai'
    const startedWithPunish = PUNISH_URL_RE.test(targetUrl)

    // A redirect away from the punish flow means the captcha was accepted.
    win.webContents.on('did-navigate', (_event, url) => {
      if (startedWithPunish && !PUNISH_URL_RE.test(url)) {
        console.log('[QwenCaptcha] Redirected away from punish page, treating as solved:', url)
        void finish(true)
      }
    })

    win.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
      if (isMainFrame && url === targetUrl) {
        console.warn('[QwenCaptcha] Failed to load punish url, falling back to chat page:', code, desc)
        win.loadURL('https://chat.qwen.ai').catch(() => {})
      }
    })

    win.webContents.on('dom-ready', () => {
      win.webContents.executeJavaScript(injectConfirmBarScript()).catch(() => {})
      // First automatic attempt shortly after the captcha page is ready.
      if (!autoSlideAttempted) {
        autoSlideAttempted = true
        setTimeout(triggerAutoSlide, 2000 + Math.floor(Math.random() * 1500))
      }
    })

    win.on('closed', () => {
      void finish(false)
    })

    pollTimer = setInterval(() => {
      if (settled || win.isDestroyed()) return
      win.webContents
        .executeJavaScript(pollStateScript())
        .then(
          (state: {
            done?: boolean
            hasSlider?: boolean
            successText?: boolean
            autoRequested?: boolean
          }) => {
            if (state?.done) {
              void finish(true)
            } else if (state?.successText && state?.hasSlider === false) {
              void finish(true)
            } else if (state?.autoRequested) {
              triggerAutoSlide()
            }
          }
        )
        .catch(() => {
          // Page is navigating; ignore.
        })
    }, 1200)

    win.loadURL(targetUrl).catch((error) => {
      console.error('[QwenCaptcha] loadURL error:', error)
      void finish(false)
    })
  })
}

/** Seed the captcha window session with the account's stored cookies. */
async function seedCookies(sess: Session, cookieStr: string): Promise<void> {
  if (!cookieStr) return
  for (const part of cookieStr.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const name = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (!name) continue
    try {
      await sess.cookies.set({ url: 'https://chat.qwen.ai', name, value })
    } catch {
      // Ignore individual cookie failures (expired/invalid names).
    }
  }
}

/** Collect qwen.ai cookies from the window session and merge over the old set. */
async function collectAndMergeCookies(sess: Session, existing: string): Promise<string | null> {
  const all = await sess.cookies.get({})
  const relevant = all.filter((cookie) => {
    const domain = (cookie.domain || '').replace(/^\./, '')
    return domain === 'qwen.ai' || domain.endsWith('qwen.ai')
  })
  if (relevant.length === 0) return null

  const map = new Map<string, string>()
  for (const part of existing.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim())
  }
  for (const cookie of relevant) {
    map.set(cookie.name, cookie.value)
  }
  return Array.from(map.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/** Floating control bar: auto-slide button + manual "done" confirmation. */
function injectConfirmBarScript(): string {
  return `
    (() => {
      if (document.getElementById('__captcha_done_bar')) return true;
      if (!document.body) return false;
      const bar = document.createElement('div');
      bar.id = '__captcha_done_bar';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#16a34a;color:#fff;padding:10px 16px;font:14px/1.5 system-ui,sans-serif;display:flex;align-items:center;gap:12px;box-shadow:0 -2px 8px rgba(0,0,0,.25)';
      const status = document.createElement('span');
      status.style.cssText = 'flex:1;text-align:center;';
      status.textContent = '正在尝试自动滑动…也可手动拖动滑块';
      const autoBtn = document.createElement('button');
      autoBtn.textContent = '自动滑动';
      autoBtn.style.cssText = 'background:#fff;color:#16a34a;border:none;border-radius:6px;padding:6px 14px;font:14px system-ui,sans-serif;cursor:pointer;font-weight:600;';
      autoBtn.addEventListener('click', () => {
        window.__CAPTCHA_AUTO__ = true;
        status.textContent = '正在尝试自动滑动…';
      });
      const doneBtn = document.createElement('button');
      doneBtn.textContent = '完成，返回应用';
      doneBtn.style.cssText = autoBtn.style.cssText;
      doneBtn.addEventListener('click', () => {
        window.__CAPTCHA_DONE__ = true;
        status.textContent = '已收到，正在关闭窗口…';
      });
      window.__setBarStatus = (msg) => { status.textContent = msg; };
      bar.appendChild(autoBtn);
      bar.appendChild(status);
      bar.appendChild(doneBtn);
      document.body.appendChild(bar);
      return true;
    })()
  `
}

/** Poll slider presence / success text / user confirmation + auto-slide flags. */
function pollStateScript(): string {
  return `
    (() => {
      const hasSlider = !!document.querySelector('#nc_1_n1z, #nocaptcha, .nc-container, .scale_text2, [id^="nc_"], iframe[src*="punish"]');
      const body = document.body ? (document.body.innerText || '') : '';
      const successText = /验证成功|验证通过|校验成功|验证已完成/.test(body);
      let autoRequested = false;
      if (window.__CAPTCHA_AUTO__) { autoRequested = true; window.__CAPTCHA_AUTO__ = false; }
      return { done: window.__CAPTCHA_DONE__ === true, hasSlider, successText, autoRequested };
    })()
  `
}

// ==================== Auto slide (NoCaptcha) ====================

interface SliderGeometry {
  /** Handle center in main-frame viewport coordinates. */
  x: number
  y: number
  handleWidth: number
  trackWidth: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Probe for the NoCaptcha slider handle inside one frame. */
function sliderProbeScript(): string {
  return `
    (() => {
      const selectors = ['#nc_1_n1z', '[id^="nc_"][id$="_n1z"]', '.nc_iconfont.btn_slide', '.btn_slide'];
      let handle = null;
      for (const s of selectors) { handle = document.querySelector(s); if (handle) break; }
      if (!handle) return null;
      const hb = handle.getBoundingClientRect();
      if (hb.width < 5 || hb.height < 5) return null;
      const track = handle.closest('.slidetounlock, .nc-lang-cnt') || handle.parentElement;
      const tb = track ? track.getBoundingClientRect() : hb;
      if (tb.width < hb.width + 20) return null;
      return { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2, handleWidth: hb.width, trackWidth: tb.width };
    })()
  `
}

/**
 * Locate the slider across all frames (the punish captcha usually lives in a
 * cross-origin iframe; frameTreeNode offsets convert frame-local coordinates
 * into main-frame viewport coordinates).
 */
async function locateSlider(win: BrowserWindow): Promise<SliderGeometry | null> {
  const visited = new Set<string>()

  const walk = async (frame: WebFrameMain, offsetX: number, offsetY: number): Promise<SliderGeometry | null> => {
    const key = `${frame.processId}:${frame.routingId}`
    if (visited.has(key)) return null
    visited.add(key)

    try {
      const geo = await frame.executeJavaScript(sliderProbeScript())
      if (geo && typeof geo.x === 'number') {
        return {
          x: geo.x + offsetX,
          y: geo.y + offsetY,
          handleWidth: geo.handleWidth,
          trackWidth: geo.trackWidth,
        }
      }
    } catch {
      // Frame may be gone; continue with children.
    }

    for (const child of frame.frames) {
      const node = child.frameTreeNode
      const result = await walk(child, offsetX + (node?.offsetX || 0), offsetY + (node?.offsetY || 0))
      if (result) return result
    }
    return null
  }

  return walk(win.webContents.mainFrame, 0, 0)
}

/**
 * Generate a human-like drag trajectory: cubic ease-out toward the end,
 * slight overshoot past the target then small corrections back, with
 * y-axis jitter. NoCaptcha scores the movement curve, so straight-line
 * constant-speed drags are rejected.
 */
function humanTrajectory(distance: number): Array<{ dx: number; dy: number }> {
  const points: Array<{ dx: number; dy: number }> = []
  const steps = 45 + Math.floor(Math.random() * 30)
  const overshoot = Math.min(12, 3 + Math.random() * 5 + distance * 0.015)
  let yDrift = 0

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const eased = 1 - Math.pow(1 - t, 3)
    const dx = eased * (distance + overshoot)
    yDrift += (Math.random() - 0.5) * 0.9
    yDrift = Math.max(-2.5, Math.min(2.5, yDrift))
    points.push({ dx, dy: yDrift })
  }

  // Correct back from the overshoot in a few small moves.
  const corrSteps = 4 + Math.floor(Math.random() * 4)
  for (let i = 1; i <= corrSteps; i++) {
    const t = i / corrSteps
    points.push({
      dx: distance + overshoot * (1 - t) + (Math.random() - 0.5) * 0.6,
      dy: yDrift * (1 - t),
    })
  }
  points.push({ dx: distance, dy: 0 })
  return points
}

/** Drag the slider handle with synthetic-but-trusted input events. */
async function dragSlider(win: BrowserWindow, geo: SliderGeometry): Promise<void> {
  const distance = Math.max(20, geo.trackWidth - geo.handleWidth - 1)
  const startX = Math.round(geo.x)
  const startY = Math.round(geo.y)
  const webContents = win.webContents

  // Approach the handle first, then press down after a short dwell.
  webContents.sendInputEvent({ type: 'mouseMove', x: startX, y: startY + 30, clickCount: 0 })
  await sleep(80 + Math.random() * 120)
  webContents.sendInputEvent({ type: 'mouseMove', x: startX, y: startY, clickCount: 0 })
  await sleep(120 + Math.random() * 200)
  webContents.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 })
  await sleep(60 + Math.random() * 120)

  const trajectory = humanTrajectory(distance)
  for (let i = 0; i < trajectory.length; i++) {
    if (win.isDestroyed()) return
    const { dx, dy } = trajectory[i]
    webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(startX + dx),
      y: Math.round(startY + dy),
      clickCount: 0,
    })
    // Variable cadence with occasional micro-pauses.
    await sleep(6 + Math.random() * 14)
    if (Math.random() < 0.04) await sleep(40 + Math.random() * 60)
  }

  // Hold briefly at the end before releasing (humans don't snap-release).
  await sleep(80 + Math.random() * 150)
  webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(startX + distance),
    y: startY,
    button: 'left',
    clickCount: 1,
  })
}

async function setBarStatus(win: BrowserWindow, message: string): Promise<void> {
  if (win.isDestroyed()) return
  const escaped = message.replace(/'/g, "\\'")
  try {
    await win.webContents.executeJavaScript(
      `window.__setBarStatus && window.__setBarStatus('${escaped}')`
    )
  } catch {
    // Bar not present; ignore.
  }
}

/**
 * Full auto-slide flow: wait for the slider to appear, drag it, verify via
 * the state poll script, retry up to 3 times. Returns true when the captcha
 * reported success (the poll timer then finishes the window normally).
 */
async function attemptAutoSlide(win: BrowserWindow): Promise<boolean> {
  // Wait up to ~20s for the slider to render.
  let geo: SliderGeometry | null = null
  for (let i = 0; i < 40; i++) {
    if (win.isDestroyed()) return false
    geo = await locateSlider(win)
    if (geo) break
    await sleep(500)
  }
  if (!geo) {
    console.log('[QwenCaptcha] Auto slide: slider not found')
    return false
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (win.isDestroyed()) return false
    console.log(`[QwenCaptcha] Auto slide attempt ${attempt}/3`)
    void setBarStatus(win, `正在自动滑动（第 ${attempt} 次）…`)

    await sleep(400 + Math.random() * 600)
    const fresh = attempt === 1 ? geo : (await locateSlider(win)) || geo
    await dragSlider(win, fresh)

    // Give NoCaptcha time to validate the trajectory server-side.
    await sleep(1800 + Math.random() * 1000)
    if (win.isDestroyed()) return false

    try {
      const state = await win.webContents.executeJavaScript(pollStateScript())
      if (state?.successText || state?.done) {
        console.log('[QwenCaptcha] Auto slide succeeded')
        void setBarStatus(win, '自动滑动成功，窗口即将关闭…')
        return true
      }
    } catch {
      // Page may be navigating after success; let the poll timer decide.
      return false
    }
  }

  console.log('[QwenCaptcha] Auto slide failed after 3 attempts')
  return false
}
