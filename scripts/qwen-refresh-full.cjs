// Ad-hoc probe: full official header set for Qwen AI /auths/refresh.
const axios = require('axios')

const rt = process.argv[2]
const URL = 'https://auth.qwen.ai/api/v2/auths/refresh'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })

;(async () => {
  const r = await axios.get(URL, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Version: '0.3.12',
      source: 'web',
      'X-Request-Id': uuid(),
      Timezone: new Date().toString().replace(/\s*\([^)]*\)\s*$/, ''),
      'x-request-origin': 'https://chat.qwen.ai',
      Origin: 'https://chat.qwen.ai',
      Cookie: `refresh_token=${rt}`,
      'User-Agent': UA,
    },
    validateStatus: () => true,
    timeout: 20000,
  })
  console.log('status', r.status)
  const body = JSON.stringify(r.data)
  console.log(body.slice(0, 400))
  const at = r.data?.data?.access_token
  if (at) {
    const payload = JSON.parse(Buffer.from(at.split('.')[1], 'base64').toString('utf8'))
    console.log('NEW TOKEN payload:', JSON.stringify(payload))
    console.log('NEW_TOKEN=' + at)
  }
})()
