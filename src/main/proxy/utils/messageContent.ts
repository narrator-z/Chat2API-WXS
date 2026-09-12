/**
 * Message Content Utilities
 *
 * OpenAI-compatible clients may send `message.content` as either a plain
 * string or a multimodal array like:
 *   [{ type: 'text', text: '...' }, { type: 'image_url', image_url: { url } }]
 *
 * Every adapter that flattens messages into a text prompt MUST use these
 * helpers instead of `String(content)` / template interpolation, otherwise
 * array content becomes "[object Object]" and images are silently dropped.
 */

/** Loose content shape accepted from clients (string | parts[] | null) */
export type MessageContentValue = unknown

/**
 * Safely extract the plain-text portion of a message content value.
 * - string -> returned as-is
 * - array  -> all `text` parts joined with newlines
 * - anything else (null/undefined/object) -> ''
 *
 * Never returns "[object Object]".
 */
export function extractTextFromContent(content: MessageContentValue): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === 'object' &&
          (part as any).type === 'text' &&
          typeof (part as any).text === 'string'
      )
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

/**
 * Count `image_url` parts inside a single message content value.
 */
export function countImagesInContent(content: MessageContentValue): number {
  if (!Array.isArray(content)) {
    return 0
  }
  return content.filter(
    (part) => !!part && typeof part === 'object' && (part as any).type === 'image_url'
  ).length
}

/**
 * Count `image_url` parts across a list of messages.
 */
export function countImagesInMessages(
  messages: Array<{ content?: MessageContentValue } | undefined | null>
): number {
  let total = 0
  for (const msg of messages) {
    if (msg) {
      total += countImagesInContent(msg.content)
    }
  }
  return total
}

/**
 * Whether a single message content value contains any image part.
 */
export function hasImageContent(content: MessageContentValue): boolean {
  return countImagesInContent(content) > 0
}

/**
 * Notice appended to the flattened prompt so the model (and the end user
 * reading the reply) knows images were sent but could not be delivered
 * through this provider channel.
 */
export function buildImageOmissionNotice(imageCount: number): string {
  return `[Notice: ${imageCount} image(s) were sent by the user but omitted, because the current provider channel does not support image input. Please tell the user images cannot be processed.]`
}

/**
 * Flatten message content to text; if the content carries images, append the
 * omission notice so they are not silently dropped.
 */
export function flattenContentWithImageNotice(content: MessageContentValue): string {
  const text = extractTextFromContent(content)
  const images = countImagesInContent(content)
  if (images === 0) {
    return text
  }
  const notice = buildImageOmissionNotice(images)
  return text ? `${text}\n\n${notice}` : notice
}
