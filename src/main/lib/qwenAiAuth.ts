/**
 * Qwen AI (chat.qwen.ai / auth.qwen.ai) auth helpers shared by the
 * account checker, the OAuth adapter and the proxy adapter.
 *
 * Access tokens expire after ~15 minutes. The official web client silently
 * refreshes them via GET https://auth.qwen.ai/api/v2/auths/refresh using the
 * long-lived `refresh_token` cookie plus a custom `x-request-origin` header
 * (verified against frontend bundle 0.3.12 on 2026-09-29). Without
 * `X-Request-Id`/`Timezone`/`x-request-origin` the endpoint rejects the
 * request with "Missing origin" / "Invalid request header".
 */
import axios from 'axios'
import { randomUUID } from 'crypto'

const QWEN_AI_BASE = 'https://chat.qwen.ai'
const QWEN_AI_AUTH_BASE = 'https://auth.qwen.ai'
const WEB_VERSION = '0.3.12'

function uuid(): string {
  return randomUUID()
}

export interface QwenAiTokenPair {
  accessToken: string
  refreshToken: string
}

/**
 * Normalize the stored cookies credential into a Cookie header string.
 * In-app login collects cookies as a name -> value object; HAR/manual imports
 * may store a raw Cookie header string. Both shapes must work here.
 */
export function normalizeCookies(cookies: unknown): string {
  if (!cookies) return ''
  if (typeof cookies === 'string') return cookies
  if (typeof cookies === 'object') {
    return Object.entries(cookies as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
  }
  return String(cookies)
}

/** Pull `refresh_token` out of credentials (explicit field, cookie object or cookie string). */
export function extractQwenAiRefreshToken(credentials: Record<string, string>): string {
  if (credentials.refresh_token) return credentials.refresh_token
  // In-app login stores cookies as an object { refresh_token: '...' }; HAR/manual
  // imports store a raw cookie header string. Handle both shapes.
  const rawCookies = (credentials as Record<string, unknown>).cookies ?? (credentials as Record<string, unknown>).cookie
  if (rawCookies && typeof rawCookies === 'object') {
    const token = (rawCookies as Record<string, unknown>).refresh_token
    if (typeof token === 'string' && token) return token
  }
  const cookies = normalizeCookies(rawCookies)
  const match = cookies.match(/(?:^|;\s*)refresh_token=([^;]+)/)
  return match ? match[1] : ''
}

/** Replace (or append) the refresh_token cookie inside a cookie string. */
export function replaceRefreshTokenCookie(cookies: string, refreshToken: string): string {
  if (!refreshToken) return cookies
  const normalized = normalizeCookies(cookies)
  if (/(?:^|;\s*)refresh_token=/.test(normalized)) {
    return normalized.replace(/((?:^|;\s*)refresh_token=)[^;]+/, `$1${refreshToken}`)
  }
  return normalized ? `${normalized}; refresh_token=${refreshToken}` : `refresh_token=${refreshToken}`
}

/** Decode the `exp` claim (seconds) from a JWT, or null when unreadable. */
export function getQwenAiTokenExp(token: string): number | null {
  if (!token) return null
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

/** True when the token is missing/expired or expires within `skewMs`. */
export function isQwenAiTokenExpiring(token: string, skewMs: number = 120000): boolean {
  const exp = getQwenAiTokenExp(token)
  if (!token) return true
  if (exp === null) return false
  return exp * 1000 - Date.now() <= skewMs
}

/**
 * Exchange a refresh_token for a fresh access/refresh token pair.
 * Returns null when the refresh token is missing or the request fails.
 */
export async function refreshQwenAiToken(refreshToken: string): Promise<QwenAiTokenPair | null> {
  if (!refreshToken) return null

  try {
    const response = await axios.get(`${QWEN_AI_AUTH_BASE}/api/v2/auths/refresh`, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Version: WEB_VERSION,
        source: 'web',
        'X-Request-Id': uuid(),
        Timezone: new Date().toString().replace(/\s*\([^)]*\)\s*$/, ''),
        'x-request-origin': QWEN_AI_BASE,
        Origin: QWEN_AI_BASE,
        Cookie: `refresh_token=${refreshToken}`,
      },
      timeout: 20000,
      validateStatus: () => true,
    })

    const data = response.data
    const accessToken = data?.data?.access_token
    if (response.status !== 200 || !data?.success || !accessToken) {
      console.warn(
        '[QwenAI] Token refresh failed:',
        response.status,
        JSON.stringify(data).slice(0, 300)
      )
      return null
    }

    return {
      accessToken,
      refreshToken: data.data.refresh_token || refreshToken,
    }
  } catch (error) {
    console.error(
      '[QwenAI] Token refresh error:',
      error instanceof Error ? error.message : error
    )
    return null
  }
}
