// Ad-hoc probe: replicate the FIXED qwen-ai proxy adapter request flow
// (createChat -> /api/v2/chat/completions) using a fresh token + cookies,
// to verify whether removing stale bx-* headers + adding cnaui/aui avoids
// the Aliyun WAF risk-control punish (FAIL_SYS_USER_VALIDATE / RGV587).
//
// Usage: node scripts/qwen-completions-probe.mjs "<TOKEN>" "<COOKIES>"

import axios from 'axios'

const BASE = 'https://chat.qwen.ai'
const TOKEN = process.argv[2]
const COOKIES_RAW = process.argv[3] || ''

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function getUidFromToken(token) {
  try {
    const part = token.split('.')[1]
    const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'))
    return payload.id || payload.sub || ''
  } catch {
    return ''
  }
}

function ensureUidCookies(cookies, uid) {
  if (!uid) return cookies
  const parts = cookies ? cookies.split(';').map((c) => c.trim()).filter(Boolean) : []
  const hasCnaui = parts.some((c) => c.startsWith('cnaui='))
  const hasAui = parts.some((c) => c.startsWith('aui='))
  if (!hasCnaui) parts.push(`cnaui=${uid}`)
  if (!hasAui) parts.push(`aui=${uid}`)
  return parts.join('; ')
}

function getTimezoneHeader() {
  return new Date().toString().replace(/\s*\([^)]*\)\s*$/, '')
}

const uid = getUidFromToken(TOKEN)
const cookies = ensureUidCookies(COOKIES_RAW, uid)

console.log('[probe] uid =', uid)
console.log('[probe] cookies length =', cookies.length)

function getHeaders(chatId) {
  const headers = {
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
    Version: '0.3.12',
    Origin: 'https://chat.qwen.ai',
    Timezone: getTimezoneHeader(),
    Authorization: `Bearer ${TOKEN}`,
    'X-Request-Id': uuid(),
  }
  if (chatId) headers['Referer'] = `https://chat.qwen.ai/c/${chatId}`
  if (cookies) headers['Cookie'] = cookies
  return headers
}

const client = axios.create({ timeout: 60000, maxBodyLength: Infinity, maxContentLength: Infinity })

async function main() {
  const modelId = 'qwen3.7-plus'

  // 1) create chat
  const chatRes = await client.post(
    `${BASE}/api/v2/chats/new`,
    {
      title: 'OpenAI_API_Chat',
      models: [modelId],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    },
    { headers: getHeaders(), validateStatus: () => true }
  )
  console.log('[probe] createChat status =', chatRes.status)
  console.log('[probe] createChat data =', JSON.stringify(chatRes.data).slice(0, 400))
  const chatId = chatRes.data?.data?.id
  if (!chatId) {
    console.error('[probe] FAILED: no chat id')
    return
  }

  // 2) completions (stream)
  const fid = uuid()
  const childId = uuid()
  const ts = Math.floor(Date.now() / 1000)
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
        content: '请只回复数字 1',
        user_action: 'chat',
        files: [],
        timestamp: ts,
        models: [modelId],
        chat_type: 't2t',
        feature_config: {
          thinking_enabled: false,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_format: 'summary',
          auto_search: false,
        },
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: null,
      },
    ],
    timestamp: ts + 1,
  }

  const res = await client.post(`${BASE}/api/v2/chat/completions?chat_id=${chatId}`, payload, {
    headers: { ...getHeaders(chatId), 'x-accel-buffering': 'no' },
    responseType: 'stream',
    validateStatus: () => true,
  })
  console.log('[probe] completions status =', res.status)

  let collected = ''
  let riskControlled = false
  res.data.on('data', (buf) => {
    const text = buf.toString()
    collected += text
    if (text.includes('FAIL_SYS_USER_VALIDATE') || text.includes('RGV587') || text.includes('aliyun_waf')) {
      riskControlled = true
    }
    process.stdout.write(text.slice(0, 300))
  })
  res.data.on('end', () => {
    console.log('\n\n========== PROBE RESULT ==========')
    console.log('[probe] riskControlled =', riskControlled)
    console.log('[probe] total bytes =', collected.length)
    console.log('[probe] head =', collected.slice(0, 600))
  })
  res.data.on('error', (e) => {
    console.error('\n[probe] stream error =', e.message)
  })
}

main().catch((e) => {
  console.error('[probe] fatal =', e.response?.status, e.message)
  if (e.response?.data) console.error('[probe] data =', JSON.stringify(e.response.data).slice(0, 500))
})
