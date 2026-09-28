// Ad-hoc probe: matrix-test header combos for Qwen AI /auths/refresh.
const axios = require('axios')

const rt = process.argv[2]
const URL = 'https://auth.qwen.ai/api/v2/auths/refresh'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

const combos = [
  { name: 'no-referer', h: { Accept: 'application/json', source: 'web', Version: '0.3.12', Origin: 'https://chat.qwen.ai', 'x-request-origin': 'https://chat.qwen.ai', Cookie: `refresh_token=${rt}`, 'User-Agent': UA } },
  { name: 'no-version', h: { Accept: 'application/json', source: 'web', Origin: 'https://chat.qwen.ai', 'x-request-origin': 'https://chat.qwen.ai', Cookie: `refresh_token=${rt}`, 'User-Agent': UA } },
  { name: 'no-origin-hdr', h: { Accept: 'application/json', source: 'web', Version: '0.3.12', 'x-request-origin': 'https://chat.qwen.ai', Cookie: `refresh_token=${rt}`, 'User-Agent': UA } },
  { name: 'content-type', h: { Accept: 'application/json', 'Content-Type': 'application/json', source: 'web', Version: '0.3.12', Origin: 'https://chat.qwen.ai', 'x-request-origin': 'https://chat.qwen.ai', Cookie: `refresh_token=${rt}`, 'User-Agent': UA } },
  { name: 'auth-origin-com', h: { Accept: 'application/json', source: 'web', Version: '0.3.12', Origin: 'https://chat.qwen.ai', 'x-request-origin': 'https://chat.qwen.ai/', Cookie: `refresh_token=${rt}`, 'User-Agent': UA } },
]

;(async () => {
  for (const c of combos) {
    try {
      const r = await axios.get(URL, { headers: c.h, validateStatus: () => true, timeout: 20000 })
      const body = JSON.stringify(r.data)
      const at = r.data?.data?.access_token
      console.log(c.name, '->', r.status, body.slice(0, 200))
      if (at) {
        const payload = JSON.parse(Buffer.from(at.split('.')[1], 'base64').toString('utf8'))
        console.log('  NEW TOKEN payload:', JSON.stringify(payload))
        console.log('  NEW_TOKEN=' + at)
      }
    } catch (e) {
      console.log(c.name, 'ERR', e.message)
    }
  }
})()
