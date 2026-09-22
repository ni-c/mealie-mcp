import { ToolInputError } from './result.js';

/**
 * Cap on an inline image payload.
 *
 * A base64 photo of a cookbook page, or a recipe's cover image, is a few
 * hundred kB — the limit exists so a runaway argument cannot be turned into
 * memory pressure or a multi-megabyte upload.
 */
export const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;

export const IMAGE_MIME_TYPES = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

/** Strict base64 decode: a malformed argument must not reach Mealie as garbage. */
export function decodeBase64(value: string, field: string): Buffer {
  const cleaned = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new ToolInputError(
      `${field} is not valid base64. Pass the raw encoding without a "data:" prefix.`
    );
  }
  return Buffer.from(cleaned, 'base64');
}
