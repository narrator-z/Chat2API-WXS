import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractTextFromContent,
  countImagesInContent,
  countImagesInMessages,
  hasImageContent,
  buildImageOmissionNotice,
  flattenContentWithImageNotice,
} from '../../src/main/proxy/utils/messageContent.ts'
import { buildMimoQuery } from '../../src/main/proxy/adapters/mimo.ts'

test('extractTextFromContent returns strings as-is', () => {
  assert.equal(extractTextFromContent('hello'), 'hello')
  assert.equal(extractTextFromContent(''), '')
})

test('extractTextFromContent extracts text parts from multimodal arrays', () => {
  const content = [
    { type: 'text', text: 'describe this' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'text', text: 'second part' },
  ]
  assert.equal(extractTextFromContent(content), 'describe this\nsecond part')
})

test('extractTextFromContent never produces [object Object]', () => {
  const content = [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]
  const text = extractTextFromContent(content)
  assert.equal(text, '')
  assert.ok(!text.includes('[object Object]'))

  // null / undefined / plain objects
  assert.equal(extractTextFromContent(null), '')
  assert.equal(extractTextFromContent(undefined), '')
  assert.equal(extractTextFromContent({ foo: 'bar' }), '')
  assert.equal(extractTextFromContent(123), '')
})

test('image counting helpers', () => {
  const withImage = [
    { type: 'text', text: 'hi' },
    { type: 'image_url', image_url: { url: 'u1' } },
    { type: 'image_url', image_url: { url: 'u2' } },
  ]
  assert.equal(countImagesInContent(withImage), 2)
  assert.equal(countImagesInContent('plain text'), 0)
  assert.equal(countImagesInContent(null), 0)
  assert.equal(hasImageContent(withImage), true)
  assert.equal(hasImageContent('plain'), false)

  assert.equal(
    countImagesInMessages([
      { role: 'user', content: withImage },
      { role: 'user', content: 'text only' },
      { role: 'assistant', content: null },
      undefined,
    ]),
    2
  )
})

test('buildImageOmissionNotice mentions the count', () => {
  const notice = buildImageOmissionNotice(3)
  assert.match(notice, /3 image/)
  assert.match(notice, /does not support image input/)
})

test('flattenContentWithImageNotice appends notice only when images exist', () => {
  assert.equal(flattenContentWithImageNotice('just text'), 'just text')

  const content = [
    { type: 'text', text: 'what is this?' },
    { type: 'image_url', image_url: { url: 'u1' } },
  ]
  const flattened = flattenContentWithImageNotice(content)
  assert.match(flattened, /^what is this\?\n\n/)
  assert.match(flattened, /1 image\(s\) were sent/)

  // image-only content still yields the notice, never empty string
  const imageOnly = flattenContentWithImageNotice([
    { type: 'image_url', image_url: { url: 'u1' } },
  ])
  assert.match(imageOnly, /1 image\(s\) were sent/)
})

test('buildMimoQuery appends image omission notice for multimodal input', () => {
  const query = buildMimoQuery([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'describe the picture' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    },
  ] as any)
  assert.match(query, /describe the picture/)
  assert.match(query, /1 image\(s\) were sent by the user but omitted/)
  assert.ok(!query.includes('[object Object]'))
})

test('buildMimoQuery keeps plain string messages untouched', () => {
  const query = buildMimoQuery([{ role: 'user', content: 'hello' }] as any)
  assert.equal(query, 'hello')
})
