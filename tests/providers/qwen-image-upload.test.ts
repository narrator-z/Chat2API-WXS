import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  computeContentMd5Base64,
  imageFileTypeFromName,
  flattenOssHeaders,
  buildImageResourceInfos,
  buildImageMessages,
  extractImageDataUrls,
} from '../../src/main/proxy/adapters/qwen.ts'

test('computeContentMd5Base64 matches reference md5 (base64)', () => {
  const buffer = Buffer.from('hello qwen image upload', 'utf-8')
  const expected = crypto.createHash('md5').update(buffer).digest('base64')
  assert.equal(computeContentMd5Base64(buffer), expected)

  // Empty buffer still yields a deterministic digest
  assert.equal(computeContentMd5Base64(Buffer.alloc(0)), '1B2M2Y8AsgTpgAmY7PhCfg==')
})

test('imageFileTypeFromName returns uppercase extension', () => {
  assert.equal(imageFileTypeFromName('photo.png'), 'PNG')
  assert.equal(imageFileTypeFromName('a.b.jpeg'), 'JPEG')
  assert.equal(imageFileTypeFromName('noext'), 'NOEXT')
  assert.equal(imageFileTypeFromName(''), '')
})

test('flattenOssHeaders expands key/value pairs and ignores junk', () => {
  const headers = flattenOssHeaders([
    { key: 'x-oss-security-token', value: 'tok' },
    { key: 'Content-Encoding', value: '' },
    null,
    { key: 123, value: 'x' },
    'junk',
  ])
  assert.deepEqual(headers, {
    'x-oss-security-token': 'tok',
    'Content-Encoding': '',
  })
  assert.deepEqual(flattenOssHeaders(undefined), {})
  assert.deepEqual(flattenOssHeaders('nope'), {})
})

test('buildImageResourceInfos produces client-shaped resource infos', () => {
  const infos = buildImageResourceInfos([
    {
      url: 'https://cdn.example.com/a.png',
      id: 'ws_gid_1',
      fileName: 'a.png',
      fileType: 'PNG',
      fileSize: 1234,
    },
  ])
  assert.deepEqual(infos, [
    {
      url: 'https://cdn.example.com/a.png',
      id: 'ws_gid_1',
      file_format: 'png',
      file_name: 'a.png',
      file_size: '1234',
    },
  ])
})

test('buildImageMessages yields image/url card matching official client', () => {
  assert.deepEqual(buildImageMessages([]), [])

  const messages = buildImageMessages([
    {
      url: 'https://cdn.example.com/a.png',
      id: 'ws_gid_1',
      fileName: 'a.png',
      fileType: 'png',
      fileSize: 10,
    },
    {
      url: 'https://cdn.example.com/b.jpg',
      id: 'ws_gid_2',
      fileName: 'b.jpg',
      fileType: 'jpg',
      fileSize: 20,
    },
  ])

  assert.equal(messages.length, 1)
  assert.equal(messages[0].mime_type, 'image/url')
  assert.equal(messages[0].content, '')
  assert.equal(messages[0].status, 'complete')
  assert.equal(messages[0].meta_data.resource_infos.length, 2)
  assert.equal(messages[0].meta_data.resource_infos[1].id, 'ws_gid_2')
})

test('extractImageDataUrls collects only user image_url parts', () => {
  const urls = extractImageDataUrls([
    { role: 'system', content: [{ type: 'image_url', image_url: { url: 'ignored' } }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
        { type: 'image_url' },
        null,
      ],
    },
    { role: 'user', content: 'plain text' },
    { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'also-ignored' } }] },
  ])
  assert.deepEqual(urls, ['data:image/png;base64,AAA', 'https://example.com/b.png'])
})
