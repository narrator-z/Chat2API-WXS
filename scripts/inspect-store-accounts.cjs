// Ad-hoc diagnostic: dump qwen-ai accounts (status + token exp + refresh_token presence)
// from the encrypted electron-store file, to diagnose "account invalidates quickly".
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const dataPath = path.join(os.homedir(), '.chat2api', 'data.json')
const KEY = 'chat2api-fixed-encryption-key-v1'

function decrypt(data) {
  // conf (electron-store) file-level encryption:
  // [iv(16B) + ':'(1B) + ciphertext]; password = pbkdf2(encryptionKey, iv.toString(), 10000, 32, sha512)
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const iv = buf.subarray(0, 16)
  const password = crypto.pbkdf2Sync(KEY, iv.toString(), 10_000, 32, 'sha512')
  const decipher = crypto.createDecipheriv('aes-256-cbc', password, iv)
  return Buffer.concat([decipher.update(buf.subarray(17)), decipher.final()]).toString('utf8')
}

function parseMaybeEncrypted(v) {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    try {
      return JSON.parse(decrypt(v))
    } catch (e) {
      return `<undecryptable: ${e.message}>`
    }
  }
}

function jwtExp(token) {
  if (!token) return null
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'))
    return payload.exp || null
  } catch {
    return null
  }
}

const rawBuf = fs.readFileSync(dataPath)
let raw
if (rawBuf.subarray(0, 1).toString() === '{') {
  raw = JSON.parse(rawBuf.toString('utf8'))
} else {
  raw = JSON.parse(decrypt(rawBuf))
}
const accounts = raw.accounts || []
console.log('Total accounts:', accounts.length)
const now = Date.now()
for (const a of accounts) {
  const creds = parseMaybeEncrypted(a.credentials) || {}
  const cookies = creds.cookies || creds.cookie || ''
  const rt = creds.refresh_token || (cookies.match(/(?:^|;\s*)refresh_token=([^;]+)/) || [])[1] || ''
  const exp = jwtExp(creds.token || '')
  const rtExp = jwtExp(rt)
  console.log('---')
  console.log('id:', a.id)
  console.log('providerId:', a.providerId)
  console.log('name:', a.name)
  console.log('status:', a.status, '| statusMessage:', a.statusMessage || a.error || '')
  console.log('lastUsed:', a.lastUsed ? new Date(a.lastUsed).toISOString() : 'never')
  console.log('updatedAt:', a.updatedAt ? new Date(a.updatedAt).toISOString() : '-')
  console.log('token exp:', exp ? new Date(exp * 1000).toISOString() + (exp * 1000 < now ? ' (EXPIRED ' + Math.round((now / 1000 - exp) / 60) + ' min ago)' : ' (valid ' + Math.round((exp - now / 1000) / 60) + ' min left)') : 'none/unreadable')
  console.log('refresh_token present:', !!rt, '| rt exp:', rtExp ? new Date(rtExp * 1000).toISOString() : '-')
  console.log('rt fingerprint:', rt ? rt.slice(-12) : '')
  console.log('token fingerprint:', creds.token ? creds.token.slice(-12) : '')
  console.log('cookie names:', cookies.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean).join(','))
}

// recent request logs for qwen-ai
const logs = raw.requestLogs || []
const qlogs = logs.filter((l) => l.providerId === 'qwen-ai').slice(-8)
console.log('\n=== last qwen-ai request logs:', qlogs.length, '===')
for (const l of qlogs) {
  console.log(new Date(l.timestamp).toISOString(), '|', l.status, l.statusCode || '', '|', l.model, '|', l.errorMessage ? 'ERR: ' + String(l.errorMessage).slice(0, 120) : '')
}
