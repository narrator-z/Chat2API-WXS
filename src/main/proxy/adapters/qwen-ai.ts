/**
 * Qwen AI International Adapter
 * Implements chat.qwen.ai API protocol
 * Based on qwen3-reverse project
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import { storeManager } from '../../store/store'
import {
  extractQwenAiRefreshToken,
  isQwenAiTokenExpiring,
  refreshQwenAiToken,
  normalizeCookies,
  replaceRefreshTokenCookie,
} from '../../lib/qwenAiAuth'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'
import {
  buildImageOmissionNotice,
  countImagesInMessages,
  extractTextFromContent,
} from '../utils/messageContent'

const QWEN_AI_BASE = 'https://chat.qwen.ai'

// NOTE: The real web client (verified via browser capture on 2026-09-28) does NOT
// send bx-v / bx-umidtoken / bx-ua headers. Those were stale hardcoded Baxia
// fingerprints which actively trigger the Aliyun WAF punish/captcha flow
// (FAIL_SYS_USER_VALIDATE / RGV587_ERROR). Keep headers aligned with the browser:
// Accept, Accept-Language, Content-Type, Version, Timezone, source, X-Request-Id,
// X-Accel-Buffering, Authorization (+ browser-managed cookies).
const WEB_VERSION = '0.3.12'

function getTimezoneHeader(): string {
  // Browser sends e.g. "Mon Sep 28 2026 19:16:20 GMT+0800" (no tz name suffix)
  return new Date().toString().replace(/\s*\([^)]*\)\s*$/, '')
}

const DEFAULT_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Content-Type': 'application/json',
  source: 'web',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  Version: WEB_VERSION,
  Origin: 'https://chat.qwen.ai',
}

/**
 * Decode the user id (uid) from the JWT access token payload.
 * Qwen AI tokens use `id` in the payload; `sub` kept as fallback.
 */
function getUidFromToken(token: string): string {
  if (!token) return ''
  try {
    const part = token.split('.')[1]
    if (!part) return ''
    const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'))
    return payload.id || payload.sub || ''
  } catch {
    return ''
  }
}

/**
 * The web client sets `cnaui=<uid>` and `aui=<uid>` cookies after login.
 * Cookies captured during in-app login may miss them; append when absent.
 */
function ensureUidCookies(cookies: string, uid: string): string {
  if (!uid) return cookies
  const parts = cookies ? cookies.split(';').map((c) => c.trim()).filter(Boolean) : []
  const hasCnaui = parts.some((c) => c.startsWith('cnaui='))
  const hasAui = parts.some((c) => c.startsWith('aui='))
  if (!hasCnaui) parts.push(`cnaui=${uid}`)
  if (!hasAui) parts.push(`aui=${uid}`)
  return parts.join('; ')
}

/**
 * Detect Aliyun/Baxia WAF risk-control punish responses such as:
 * {"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试"],"data":{"url":"...punish..."}}
 */
function getRiskControlMessage(data: any): string | null {
  if (!data || typeof data !== 'object') return null
  const ret = Array.isArray(data.ret) ? data.ret : []
  const retStr = ret.map(String).join('|')
  if (retStr.includes('FAIL_SYS_USER_VALIDATE') || retStr.includes('RGV587')) {
    return `Qwen AI 风控拦截（需要验证码校验）：${retStr || 'FAIL_SYS_USER_VALIDATE'}。请稍后重试；若持续出现，请重新登录该账号以刷新 cookies。`
  }
  return null
}

const RISK_CONTROL_BLOCKED_MESSAGE =
  'Qwen AI 风控拦截（需要验证码校验）：验证码未完成或验证后仍被拦截，请稍后重试。'

/** Extract the punish/captcha url from a WAF risk-control payload text. */
function extractPunishUrl(text: string): string | null {
  if (!text.includes('FAIL_SYS_USER_VALIDATE') && !text.includes('RGV587')) return null
  try {
    const parsed = JSON.parse(text)
    const url = parsed?.data?.url
    if (typeof url === 'string' && url) return url
  } catch {
    // Not JSON; fall through to regex extraction.
  }
  const match = text.match(/https?:[^"'\s]+punish[^"'\s]*/)
  return match ? match[0] : null
}

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3.7-max',
  qwen3: 'qwen3.7-max',
  'qwen3.8': 'qwen3.8-max',
  'qwen3.8-max': 'qwen3.8-max',
  'qwen3.7': 'qwen3.7-max',
  'qwen3.7-plus': 'qwen3.7-plus',
  'qwen3.6': 'qwen3.6-plus',
}

interface QwenAiMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | any[]
}

interface ChatCompletionRequest {
  model: string
  /** Original model name before mapping (used for feature detection like thinking mode) */
  originalModel?: string
  messages: QwenAiMessage[]
  stream?: boolean
  temperature?: number
  enable_thinking?: boolean
  thinking_budget?: number
  chatId?: string
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function timestamp(): number {
  return Date.now()
}

function extractText(value: any): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(extractText).join('')
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (typeof value.value === 'string') return value.value
  }

  return ''
}

function extractDeltaContent(delta: any, choice: any): string {
  return extractText(delta.content)
    || extractText(delta.text)
    || extractText(delta.message?.content)
    || extractText(choice.message?.content)
    || extractText(choice.text)
}

function isFinishedStatus(status: any): boolean {
  return status === 'finished' || status === 'finish' || status === 'completed' || status === 'done'
}

function getQwenAiErrorMessage(data: any): string | null {
  if (!data || typeof data !== 'object') {
    return null
  }

  // WAF risk-control punish payload (not a success:false envelope)
  const riskControl = getRiskControlMessage(data)
  if (riskControl) {
    return riskControl
  }

  if (data.success !== false) {
    return null
  }

  const code = data.data?.code || data.code || 'QWEN_AI_ERROR'
  const details = data.data?.details || data.message || data.msg || 'Qwen AI request failed'
  return `${code}: ${details}`
}

export class QwenAiAdapter {
  private provider: Provider
  private account: Account
  /**
   * Optional hook invoked when the Aliyun WAF risk-control punish is detected
   * on the completions stream. Implementations typically open a captcha
   * window; resolves with the refreshed cookie string once the user solved
   * the captcha (or null when unsolved/closed).
   */
  onRiskControl?: (punishUrl?: string) => Promise<string | null>
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.apiKey || ''
  }

  /**
   * Qwen AI access tokens expire after ~15 minutes. The official client
   * silently refreshes them via GET auth.qwen.ai/api/v2/auths/refresh using
   * the refresh_token cookie plus the `x-request-origin` header. Mirror that
   * behaviour so long-lived proxy sessions never hit "Token has expired".
   */
  async ensureValidToken(force: boolean = false): Promise<string> {
    const current = this.getToken()
    if (!force && !isQwenAiTokenExpiring(current)) {
      return current
    }

    const refreshToken = extractQwenAiRefreshToken(this.account.credentials)
    if (!refreshToken) {
      return current
    }

    console.log('[QwenAI] Access token expiring/expired, refreshing via auth.qwen.ai...')
    const refreshed = await refreshQwenAiToken(refreshToken)
    if (!refreshed) {
      return current
    }

    this.account.credentials = {
      ...this.account.credentials,
      token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      cookies: replaceRefreshTokenCookie(this.getCookies(), refreshed.refreshToken),
    }

    try {
      storeManager.updateAccount(this.account.id, { credentials: { ...this.account.credentials } })
      console.log('[QwenAI] Refreshed token persisted for account', this.account.id)
    } catch (error) {
      console.error('[QwenAI] Failed to persist refreshed token:', error)
    }

    return refreshed.accessToken
  }

  private getCookies(): string {
    const credentials = this.account.credentials
    // In-app login may store cookies as a name -> value object; normalize to a
    // Cookie header string so downstream string ops (split/match) never throw.
    return normalizeCookies((credentials as Record<string, unknown>).cookies ?? (credentials as Record<string, unknown>).cookie)
  }

  private getHeaders(chatId?: string): Record<string, string> {
    const token = this.getToken()
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      Timezone: getTimezoneHeader(),
      Authorization: `Bearer ${token}`,
      'X-Request-Id': uuid(),
    }

    if (chatId) {
      headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
    }

    // The web client always carries cnaui/aui (uid) cookies; append them when missing.
    const cookies = ensureUidCookies(this.getCookies(), getUidFromToken(token))
    if (cookies) {
      headers['Cookie'] = cookies
    } else {
      console.warn('[QwenAI] Warning: No cookies provided. This may cause Bad_Request error.')
      console.warn('[QwenAI] Required cookies: cnaui, aui, sca, xlly_s, cna, token, _bl_uid, x-ap')
    }

    return headers
  }

  mapModel(openaiModel: string): string {
    let model = openaiModel
    let forceThinking: boolean | undefined
    
    if (model.endsWith('-thinking')) {
      forceThinking = true
      model = model.slice(0, -9)
    } else if (model.endsWith('-fast')) {
      forceThinking = false
      model = model.slice(0, -5)
    }
    
    ;(this as any)._forceThinking = forceThinking
    
    const lowerModel = model.toLowerCase()
    
    if (MODEL_ALIASES[lowerModel]) {
      return MODEL_ALIASES[lowerModel]
    }
    
    if (this.provider.modelMappings) {
      for (const [key, value] of Object.entries(this.provider.modelMappings)) {
        if (key.toLowerCase() === lowerModel) {
          return value
        }
      }
    }
    
    return model
  }

  async createChat(modelId: string, title: string = 'New Chat'): Promise<string> {
    await this.ensureValidToken()

    const url = `${QWEN_AI_BASE}/api/v2/chats/new`
    const payload = {
      title,
      models: [modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    }

    const post = () =>
      this.axiosInstance.post(url, payload, {
        headers: this.getHeaders(),
      })

    try {
      let response = await post()

      // Server-side rejection despite a locally-valid exp (clock skew or
      // early revocation): force-refresh the token and retry once.
      const details = String(response.data?.data?.details || '')
      if (response.data?.data?.code === 'unauthorized' || /token has expired/i.test(details)) {
        console.log('[QwenAI] createChat unauthorized, forcing token refresh and retrying...')
        await this.ensureValidToken(true)
        response = await post()
      }

      console.log('[QwenAI] Create chat response:', JSON.stringify(response.data, null, 2))

      if (response.data?.data?.id) {
        console.log('[QwenAI] Created chat:', response.data.data.id)
        return response.data.data.id
      }

      const upstreamError = getQwenAiErrorMessage(response.data)
      throw new Error(upstreamError || 'Failed to create chat: no chat ID returned')
    } catch (error) {
      console.error('[QwenAI] Failed to create chat:', error)
      throw error
    }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/${chatId}`

    try {
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] Deleted chat:', chatId)
        return true
      }

      console.warn('[QwenAI] Failed to delete chat:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete chat:', error)
      return false
    }
  }

  /**
   * Delete all chats for the current account
   * @returns Promise<boolean> - true if deletion was successful
   */
  async deleteAllChats(): Promise<boolean> {
    const url = `${QWEN_AI_BASE}/api/v2/chats/`

    try {
      console.log('[QwenAI] Deleting all chats for account')
      
      const response = await this.axiosInstance.delete(url, {
        headers: this.getHeaders(),
      })

      if (response.data?.success) {
        console.log('[QwenAI] All chats deleted successfully')
        return true
      }

      console.warn('[QwenAI] Failed to delete all chats:', response.data)
      return false
    } catch (error) {
      console.error('[QwenAI] Failed to delete all chats:', error)
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    chatId: string
    parentId: string | null
  }> {
    const token = this.getToken()
    if (!token) {
      throw new Error('Qwen AI token not configured, please add token in account settings')
    }

    const modelId = this.mapModel(request.model)
    
    // Get forced thinking mode setting from originalModel (preserves user's intent before mapping)
    // If originalModel exists, use it for thinking detection; otherwise fall back to request.model
    const modelForThinking = request.originalModel || request.model
    const modelLower = modelForThinking.toLowerCase()
    let forceThinking: boolean | undefined
    if (modelForThinking.endsWith('-thinking')) {
      forceThinking = true
    } else if (modelForThinking.endsWith('-fast')) {
      forceThinking = false
    } else if (modelLower.includes('think') || modelLower.includes('r1')) {
      // Auto-enable thinking based on model name keywords (e.g. "Qwen3.6-Plus-AI-Think-Search")
      forceThinking = true
      console.log('[QwenAI] Thinking mode enabled (from model name keyword)')
    } else {
      // Use the forceThinking from mapModel if no originalModel-specific detection
      forceThinking = (this as any)._forceThinking
    }

    // Always create a new chat (single-turn mode only)
    let chatId = await this.createChat(modelId, 'OpenAI_API_Chat')
    console.log('[QwenAI] Created new chat:', chatId)

    const messages = request.messages
    
    // Extract system message and user message
    let systemContent = ''
    let userContent = ''
    
    // Single-turn mode: extract all messages
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemContent += (systemContent ? '\n\n' : '') + extractTextFromContent(msg.content)
      } else if (msg.role === 'user') {
        userContent = extractTextFromContent(msg.content)
      }
    }

    // Images cannot be delivered through the t2t channel; make the omission
    // explicit instead of silently dropping them (or worse, "[object Object]").
    const imageCount = countImagesInMessages(messages)
    if (imageCount > 0) {
      const notice = buildImageOmissionNotice(imageCount)
      userContent = userContent ? `${userContent}\n\n${notice}` : notice
    }

    // If system prompt exists, prepend it to user content
    if (systemContent) {
      userContent = `${systemContent}\n\nUser: ${userContent}`
    }

    const fid = uuid()
    const childId = uuid()
    const ts = Math.floor(Date.now() / 1000)

    // Default to disable thinking mode to avoid automatic reasoning trigger
    // Users can control thinking via:
    // 1. Model name suffix: -thinking (force thinking), -fast (force fast mode)
    // 2. enable_thinking parameter for explicit control
    // 3. If neither is specified, thinking mode is disabled by default (fast mode)
    const shouldEnableThinking = forceThinking !== undefined 
      ? forceThinking 
      : request.enable_thinking === true
    
    const featureConfig: Record<string, any> = {
      thinking_enabled: shouldEnableThinking,
      output_schema: 'phase',
      research_mode: 'normal',
      auto_thinking: shouldEnableThinking,
      thinking_format: 'summary',
      auto_search: false, // Default to disable auto search
    }

    if (request.thinking_budget) {
      featureConfig.thinking_budget = request.thinking_budget
    }

    const payload = {
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: modelId,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [childId],
          role: 'user',
          content: userContent,
          user_action: 'chat',
          files: [],
          timestamp: ts,
          models: [modelId],
          chat_type: 't2t',
          feature_config: featureConfig,
          extra: { meta: { subChatType: 't2t' } },
          sub_chat_type: 't2t',
          parent_id: null,
        },
      ],
      timestamp: ts + 1,
    }

    let response = await this.postCompletions(payload, chatId)

    // Probe the first stream chunk for the WAF punish payload. When detected
    // and a captcha hook is available, let the user solve the slider and then
    // retry the request once with the refreshed cookies.
    if (this.onRiskControl) {
      let probe = await this.probeStream(response)
      if (probe.riskControl) {
        probe.stream.destroy?.()
        console.log('[QwenAI] Risk control detected, requesting captcha verification...')
        const refreshedCookies = await this.onRiskControl(probe.punishUrl || undefined)
        if (!refreshedCookies) {
          throw new Error(RISK_CONTROL_BLOCKED_MESSAGE)
        }
        // Use the refreshed (captcha-trusted) cookies for the retry.
        this.account.credentials = { ...this.account.credentials, cookies: refreshedCookies }
        chatId = await this.createChat(modelId, 'OpenAI_API_Chat')
        payload.chat_id = chatId
        console.log('[QwenAI] Retrying after captcha with new chat:', chatId)
        response = await this.postCompletions(payload, chatId)
        probe = await this.probeStream(response)
        if (probe.riskControl) {
          probe.stream.destroy?.()
          throw new Error(RISK_CONTROL_BLOCKED_MESSAGE)
        }
      }
      response = { ...response, data: probe.stream } as AxiosResponse
    }

    return {
      response,
      chatId,
      parentId: null,
    }
  }

  private async postCompletions(payload: Record<string, any>, chatId: string): Promise<AxiosResponse> {
    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${chatId}`

    console.log('[QwenAI] Sending request to /api/v2/chat/completions...', { chatId, model: payload.model })

    const response = await this.axiosInstance.post(url, payload, {
      headers: {
        ...this.getHeaders(chatId),
        'x-accel-buffering': 'no',
      },
      responseType: 'stream',
      timeout: 120000,
    })

    console.log('[QwenAI] Response status:', response.status)
    return response
  }

  /**
   * Read the first chunk of the completions stream without losing it: the
   * chunk is replayed into a PassThrough which also receives the remainder
   * of the original stream, so downstream handlers see an intact stream.
   */
  private probeStream(response: AxiosResponse): Promise<{
    riskControl: boolean
    punishUrl: string | null
    stream: any
  }> {
    return new Promise((resolve) => {
      const source = response.data
      const replay = new PassThrough()
      const settle = (first: Buffer) => {
        const text = first.toString()
        const punishUrl = extractPunishUrl(text)
        if (first.length) replay.write(first)
        source.pipe(replay)
        resolve({ riskControl: punishUrl !== null, punishUrl, stream: replay })
      }
      const onData = (chunk: Buffer) => {
        source.pause()
        source.removeListener('data', onData)
        settle(chunk)
      }
      source.on('data', onData)
      source.once('end', () => {
        source.removeListener('data', onData)
        settle(Buffer.alloc(0))
      })
      source.once('error', () => {
        source.removeListener('data', onData)
        settle(Buffer.alloc(0))
      })
    })
  }

  static isQwenAiProvider(provider: Provider): boolean {
    return provider.id === 'qwen-ai' || provider.apiEndpoint.includes('chat.qwen.ai')
  }
}

export class QwenAiStreamHandler {
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private responseId: string = ''
  private content: string = ''
  private toolCallsSent: boolean = false

  constructor(model: string, onEnd?: (chatId: string) => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd && this.chatId) {
        this.onEnd(this.chatId)
      }
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()

    console.log('[QwenAI] Starting stream handler...')

    let reasoningText = ''
    let hasSentReasoning = false
    let summaryText = ''
    let initialChunkSent = false
    let ended = false

    const endWithDone = () => {
      if (!ended) {
        ended = true
        transStream.end('data: [DONE]\n\n')
      }
    }

    const sendError = (message: string) => {
      if (ended) return
      console.error('[QwenAI] Upstream error:', message)
      transStream.write(
        `data: ${JSON.stringify({
          error: {
            message,
            type: 'upstream_error',
            code: 'qwen_ai_error',
          },
        })}\n\n`
      )
      endWithDone()
    }

    const sendInitialChunk = () => {
      if (!initialChunkSent) {
        const initialChunk = `data: ${JSON.stringify({
          id: '',
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          created: this.created,
        })}\n\n`
        transStream.write(initialChunk)
        initialChunkSent = true
        console.log('[QwenAI] Initial chunk written')
      }
    }

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          console.log('[QwenAI] Parsed event:', event.event, 'data:', event.data?.substring(0, 200))
          
          if (event.data === '[DONE]') {
            console.log('[QwenAI] Received [DONE] signal')
            return
          }

          const data = JSON.parse(event.data)
          console.log('[QwenAI] Parsed JSON data keys:', Object.keys(data))

          const upstreamError = getQwenAiErrorMessage(data)
          if (upstreamError) {
            sendError(upstreamError)
            return
          }

          if (data['response.created']?.response_id) {
            this.responseId = data['response.created'].response_id
            console.log('[QwenAI] Got response_id:', this.responseId)
          }

          if (data.choices && data.choices.length > 0) {
            const choice = data.choices[0]
            const delta = choice.delta || {}
            const phase = delta.phase
            const status = delta.status
            const content = extractDeltaContent(delta, choice)

            console.log('[QwenAI] Phase:', phase, 'Status:', status, 'Content:', content.substring(0, 50))

            if (phase === 'think') {
              if (status !== 'finished') {
                // Stream thinking content as reasoning_content in real-time
                reasoningText += content
                if (!hasSentReasoning) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                  hasSentReasoning = true
                  console.log('[QwenAI] Sent reasoning role chunk')
                }
                if (content) {
                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.chatId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`
                  )
                }
              }
              // When status === 'finished', the think phase is done
            } else if (phase === 'thinking_summary') {
              const extra = delta.extra || {}
              console.log('[QwenAI] thinking_summary extra:', JSON.stringify(extra).substring(0, 300))
              if (extra.summary_thought?.content) {
                const newSummary = extra.summary_thought.content.join('\n')
                if (newSummary && newSummary.length > summaryText.length) {
                  // Send only the incremental diff as reasoning_content
                  const diff = newSummary.substring(summaryText.length)
                  if (diff) {
                    if (!hasSentReasoning) {
                      transStream.write(
                        `data: ${JSON.stringify({
                          id: this.responseId || this.chatId,
                          model: this.model,
                          object: 'chat.completion.chunk',
                          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                          created: this.created,
                        })}\n\n`
                      )
                      hasSentReasoning = true
                    }
                    transStream.write(
                      `data: ${JSON.stringify({
                        id: this.responseId || this.chatId,
                        model: this.model,
                        object: 'chat.completion.chunk',
                        choices: [{ index: 0, delta: { reasoning_content: diff }, finish_reason: null }],
                        created: this.created,
                      })}\n\n`
                    )
                  }
                  summaryText = newSummary
                  console.log('[QwenAI] Updated summaryText, length:', summaryText.length)
                }
              }
            } else if (phase === 'answer') {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              console.log('[QwenAI] Entering answer branch, content:', content)
              
              // Accumulate content for tool call detection
              this.content += content
              
              if (content) {
                console.log('[QwenAI] Sending content chunk:', content)
                const chunk = {
                  id: this.responseId || this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content }, finish_reason: null }],
                  created: this.created,
                }
                transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
                console.log('[QwenAI] Content chunk written')
              }
            } else if (content) {
              if (!initialChunkSent) {
                sendInitialChunk()
              }
              // Accumulate content for tool call detection
              this.content += content
              
              const chunk = {
                id: this.responseId || this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
                created: this.created,
              }
              transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }

            if ((isFinishedStatus(status) || choice.finish_reason) && (phase === 'answer' || phase == null || content)) {
              // Check for tool calls before sending stop
              if (hasToolUse(this.content)) {
                console.log('[QwenAI] Found tool_use in stream, sending tool_calls')
                this.sendToolCalls(transStream)
                return
              }
              
              const finishReason = delta.finish_reason || choice.finish_reason || 'stop'
              const finalChunk = {
                id: this.responseId || this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                created: this.created,
              }
              transStream.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
              endWithDone()

              if (this.onEnd && this.chatId) {
                this.onEnd(this.chatId)
              }
            }
          }
        } catch (err) {
          console.error('[QwenAI] Stream parse error:', err)
        }
      },
    })

    stream.on('data', (buffer: Buffer) => {
      const text = buffer.toString()
      console.log('[QwenAI] Raw stream data:', text.substring(0, 500))
      const trimmed = text.trim()
      if (trimmed.startsWith('{')) {
        try {
          // Covers both success:false envelopes and WAF risk-control payloads
          // ({"ret":["FAIL_SYS_USER_VALIDATE", "RGV587_ERROR::..."]}) which are
          // plain JSON (not SSE) and would otherwise be silently dropped,
          // producing an empty response on the frontend.
          const upstreamError = getQwenAiErrorMessage(JSON.parse(trimmed))
          if (upstreamError) {
            sendError(upstreamError)
            return
          }
        } catch {
          // Continue through the SSE parser for partial or non-JSON chunks.
        }
      }
      // WAF punish HTML/JS challenge page (aliyun_waf_aa) is also non-SSE
      if (trimmed.includes('FAIL_SYS_USER_VALIDATE') || trimmed.includes('RGV587') || trimmed.includes('aliyun_waf')) {
        sendError('Qwen AI 风控拦截（需要验证码校验），请稍后重试；若持续出现，请重新登录该账号以刷新 cookies。')
        return
      }
      parser.feed(text)
    })
    stream.once('error', (err: Error) => {
      console.error('[QwenAI] Stream error:', err)
      endWithDone()
    })
    stream.once('close', () => {
      console.log('[QwenAI] Stream closed')
      endWithDone()
    })

    return transStream
  }

  async handleNonStream(stream: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      let reasoningText = ''
      let summaryText = ''
      let resolved = false

      const resolveOnce = (value: any) => {
        if (!resolved) {
          resolved = true
          resolve(value)
        }
      }

      const rejectOnce = (reason: any) => {
        if (!resolved) {
          resolved = true
          reject(reason)
        }
      }

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            if (event.data === '[DONE]') return

            const parsed = JSON.parse(event.data)

            const upstreamError = getQwenAiErrorMessage(parsed)
            if (upstreamError) {
              rejectOnce(new Error(upstreamError))
              return
            }

            if (parsed['response.created']?.response_id) {
              this.responseId = parsed['response.created'].response_id
              data.id = this.responseId
            }

            if (parsed.choices && parsed.choices.length > 0) {
              const choice = parsed.choices[0]
              const delta = choice.delta || {}
              const phase = delta.phase
              const status = delta.status
              const content = extractDeltaContent(delta, choice)

              if (phase === 'think' && !isFinishedStatus(status)) {
                reasoningText += content
              } else if (phase === 'thinking_summary') {
                // Handle thinking_summary phase - extract summary content
                const extra = delta.extra || {}
                if (extra.summary_thought?.content) {
                  const newSummary = extra.summary_thought.content.join('\n')
                  if (newSummary && newSummary.length > summaryText.length) {
                    summaryText = newSummary
                  }
                }
              } else if (phase === 'answer') {
                if (content) {
                  data.choices[0].message.content += content
                }
                if (isFinishedStatus(status) || choice.finish_reason) {
                  // Use reasoningText or summaryText for reasoning_content
                  const finalReasoning = reasoningText || summaryText
                  if (finalReasoning) {
                    data.choices[0].message.reasoning_content = finalReasoning
                  }

                  if (this.onEnd && this.chatId) {
                    this.onEnd(this.chatId)
                  }

                  resolveOnce(data)
                }
              } else if (content) {
                data.choices[0].message.content += content
              }
            }
          } catch (err) {
            console.error('[QwenAI] Non-stream parse error:', err)
            rejectOnce(err)
          }
        },
      })

      stream.on('data', (buffer: Buffer) => {
        const text = buffer.toString()
        const trimmed = text.trim()
        if (trimmed.startsWith('{')) {
          try {
            const upstreamError = getQwenAiErrorMessage(JSON.parse(trimmed))
            if (upstreamError) {
              rejectOnce(new Error(upstreamError))
              return
            }
          } catch {
            // Continue through the SSE parser for partial or non-JSON chunks.
          }
        }
        parser.feed(text)
      })
      stream.once('error', (err: Error) => {
        console.error('[QwenAI] Non-stream error:', err)
        rejectOnce(err)
      })
      stream.once('close', () => {
        // Use reasoningText or summaryText for reasoning_content
        const finalReasoning = reasoningText || summaryText
        if (finalReasoning) {
          data.choices[0].message.reasoning_content = finalReasoning
        }
        resolveOnce(data)
      })
    })
  }

  getChatId(): string {
    return this.chatId
  }

  getResponseId(): string {
    return this.responseId
  }
}

export const qwenAiAdapter = {
  QwenAiAdapter,
  QwenAiStreamHandler,
}
