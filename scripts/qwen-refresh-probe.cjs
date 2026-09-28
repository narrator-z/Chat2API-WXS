// Ad-hoc probe: verify Qwen AI token refresh endpoint.
// Official client: GET https://auth.qwen.ai/api/v2/auths/refresh
//   withCredentials (refresh_token cookie) + browser-set Origin header.
const axios = require('axios')

const rt = process.argv[2]
if (!rt) {
  console.error('usage: node scripts/qwen-refresh-probe.cjs <refresh_token>')
  process.exit(1)
}

axios
  .get('https://auth.qwen.ai/api/v2/auths/refresh', {
    headers: {
      Accept: 'application/json',
      source: 'web',
      Version: '0.3.12',
      Origin: 'https://chat.qwen.ai',
      Referer: 'https://chat.qwen.ai/',
      'x-request-origin': 'https://chat.qwen.ai',
      Cookie: `refresh_token=${rt}`,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    },
    validateStatus: () => true,
    timeout: 20000,
  })
  .then((r) => {
    console.log('status', r.status)
    const body = JSON.stringify(r.data)
    console.log(body.slice(0, 600))
    const at = r.data?.data?.access_token
    if (at) {
      const payload = JSON.parse(Buffer.from(at.split('.')[1], 'base64').toString('utf8'))
      console.log('new access token payload:', JSON.stringify(payload))
      console.log('NEW_TOKEN=' + at)
    }
  })
  .catch((e) => console.error('ERR', e.message))
