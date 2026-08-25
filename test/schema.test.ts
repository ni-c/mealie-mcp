import { describe, expect, it } from 'vitest';

import {
  dateParam,
  httpUrl,
  recipeRefParam,
  slugParam,
  uuidParam,
} from '../src/schema.js';

describe('httpUrl', () => {
  it('accepts ordinary recipe addresses', () => {
    for (const url of [
      'https://www.bbcgoodfood.com/recipes/classic-pancakes',
      'http://example.com/rezept?id=1#zutaten',
      'https://chefkoch.de/rezepte/1',
      'https://küchen-rezepte.de/a',
    ]) {
      expect(httpUrl.safeParse(url).success).toBe(true);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(httpUrl.parse('  https://example.com/a  ')).toBe(
      'https://example.com/a'
    );
  });

  it('rejects every scheme except http and https', () => {
    // zod's own .url() accepts all of these: it only checks that new URL()
    // parses. Mealie fetches whatever it is given, server-side.
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'ftp://example.com/a',
      'gopher://example.com',
    ]) {
      const result = httpUrl.safeParse(url);
      expect(result.success, url).toBe(false);
    }
  });

  it('rejects anything that is not an absolute URL', () => {
    for (const url of ['not-a-url', '/relative/path', 'example.com', '']) {
      expect(httpUrl.safeParse(url).success, url).toBe(false);
    }
  });

  it('leaves the host to the guard that can resolve it', () => {
    // Until 0.1.2 this schema classified the host itself. It cannot resolve a
    // name — a Zod refinement is synchronous — so a DNS record pointing at
    // 127.0.0.1 walked straight past it. The host check now lives in
    // assertFetchableUrl (see hosts.test.ts); what stays here is the scheme,
    // which is worth refusing early because it needs no lookup at all.
    for (const url of [
      'http://192.168.0.7/a',
      'https://example.com/a',
      'http://127.0.0.1:9000/a',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
    ]) {
      expect(httpUrl.safeParse(url).success, url).toBe(true);
    }
  });

  it('rejects an over-long URL', () => {
    expect(
      httpUrl.safeParse(`https://example.com/${'a'.repeat(2100)}`).success
    ).toBe(false);
  });
});

describe('slugParam', () => {
  it('accepts Mealie slugs', () => {
    for (const slug of ['quark-bowl', 'a', 'a1-b2-c3']) {
      expect(slugParam.safeParse(slug).success, slug).toBe(true);
    }
  });

  it('rejects anything that could escape a path', () => {
    for (const slug of [
      '../admin',
      'a/b',
      'Quark-Bowl',
      'quark_bowl',
      'quark--bowl',
      '-quark',
      'quark-',
      '',
    ]) {
      expect(slugParam.safeParse(slug).success, slug).toBe(false);
    }
  });
});

describe('uuidParam', () => {
  it('accepts a UUID in either case', () => {
    expect(
      uuidParam.safeParse('592cf12b-700c-4e4b-ba98-4ea114ee1e5a').success
    ).toBe(true);
    expect(
      uuidParam.safeParse('592CF12B-700C-4E4B-BA98-4EA114EE1E5A').success
    ).toBe(true);
  });

  it('rejects near-misses', () => {
    for (const value of [
      '592cf12b700c4e4bba984ea114ee1e5a',
      '592cf12b-700c-4e4b-ba98',
      '592cf12b-700c-4e4b-ba98-4ea114ee1e5a-extra',
      '../../etc/passwd',
    ]) {
      expect(uuidParam.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('recipeRefParam', () => {
  it('accepts both halves of the split identifier space', () => {
    expect(recipeRefParam.safeParse('quark-bowl').success).toBe(true);
    expect(
      recipeRefParam.safeParse('592cf12b-700c-4e4b-ba98-4ea114ee1e5a').success
    ).toBe(true);
  });

  it('rejects a value that is neither', () => {
    expect(recipeRefParam.safeParse('Quark Bowl').success).toBe(false);
  });
});

describe('dateParam', () => {
  it('accepts an ISO calendar date', () => {
    expect(dateParam.safeParse('2026-08-19').success).toBe(true);
  });

  it('rejects other formats and impossible dates', () => {
    for (const value of [
      '19.08.2026',
      '2026-8-19',
      '2026-08-19T12:00:00Z',
      '2026-13-01',
      '2026-02-30',
    ]) {
      expect(dateParam.safeParse(value).success, value).toBe(false);
    }
  });
});
