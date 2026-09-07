import { describe, expect, it } from 'vitest';

import { cleanText, upstreamText } from '../src/text.js';
import { decodeEntities, imageUrlsIn } from '../src/tools/imports.js';

/**
 * Every function that walks caller or instance text, timed at the ceiling
 * the code accepts — computed from the schema, not guessed.
 *
 * `import_recipe_from_html_or_json` takes 2 MiB (`MAX_HTML_CHARS`). Before
 * this file existed, a document of `"image":[` repeated to that size cost 223
 * seconds in `imageUrlsIn`: a 4096-character window sliced, searched and
 * URL-parsed per key, two hundred thousand times over. The forms below are
 * the shortest repetitions that trigger each scan.
 */

const CEILING = 2 * 1024 * 1024;
/** Generous for CI; the scans take a few milliseconds on a workstation. */
const LIMIT_MS = 500;

function timed(fn: () => unknown): number {
  const started = performance.now();
  try {
    fn();
  } catch {
    // A refusal is a fine outcome; only the time is measured here.
  }
  return performance.now() - started;
}

function repeatTo(unit: string, size: number): string {
  return unit.repeat(Math.floor(size / unit.length));
}

describe('imageUrlsIn is linear in the document', () => {
  const forms: [string, string][] = [
    ['"image":[', '"image":['],
    ['"image":"', '"image":"'],
    ['<img ', '<img '],
    ['<meta og:image ', '<meta og:image '],
    ['<link rel=image_src ', '<link rel=image_src '],
    ['<script type=ld+json>', '<script type="application/ld+json">'],
    ['unterminated literal', '"'],
    ['nested brackets', '['],
    ['whitespace after key', '"image"' + ' '.repeat(1000)],
    ['escaped quotes', '\\"'],
    ['long tag without close', '<img ' + 'a'.repeat(1999)],
  ];
  for (const [label, unit] of forms) {
    it(`${label} at ${CEILING} characters`, () => {
      const document = repeatTo(unit, CEILING);
      expect(timed(() => imageUrlsIn(document))).toBeLessThan(LIMIT_MS);
    });
  }

  it('the exact shape that cost 223 seconds is refused in milliseconds', () => {
    const document = repeatTo('"image":[', CEILING);
    const started = performance.now();
    expect(() => imageUrlsIn(document)).toThrow(/image references/);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });
});

describe('the text helpers are linear in their input', () => {
  const size = 4 * 1024 * 1024;
  it('cleanText over controls, prose and the BOM', () => {
    for (const unit of [
      String.fromCharCode(27),
      'a',
      String.fromCodePoint(0xfeff),
    ]) {
      expect(timed(() => cleanText(unit.repeat(size), size))).toBeLessThan(
        LIMIT_MS
      );
    }
  });

  it('upstreamText over whitespace runs', () => {
    expect(timed(() => upstreamText(' '.repeat(size)))).toBeLessThan(LIMIT_MS);
  });

  it('decodeEntities over digit runs and ampersand runs', () => {
    for (const text of [
      `&#${'0'.repeat(size)};`,
      '&#'.repeat(size / 2),
      '&'.repeat(size),
      `&#x${'f'.repeat(size)}`,
      '&amp'.repeat(size / 4),
    ]) {
      expect(timed(() => decodeEntities(text))).toBeLessThan(LIMIT_MS);
    }
  });
});
