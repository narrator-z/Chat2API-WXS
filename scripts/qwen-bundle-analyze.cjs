// Ad-hoc analysis: extract how the official qwen-chat-fe bundle sets the
// `origin` header / calls /auths/refresh.
const fs = require('fs')
const path = process.env.TEMP + '\\qwen_main.js'
const s = fs.readFileSync(path, 'utf8')
const pats = ['/users/logout/']
for (const p of pats) {
  let i = -1
  let n = 0
  console.log('=== pattern:', JSON.stringify(p), '===')
  while ((i = s.indexOf(p, i + 1)) !== -1 && n < 3) {
    n++
    console.log(s.slice(Math.max(0, i - 700), i + 700).replace(/\n/g, ' '))
    console.log('---')
  }
}
