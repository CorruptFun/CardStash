/** The pure helpers in cardimage.ts never reach the decoder. */
export function decodeImage() {
  throw new Error('decodeImage is not available in node tests')
}
export const CAPTURE_MAX_EDGE = 1400
