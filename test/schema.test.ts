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

  it('rejects loopback, private, link-local and CGNAT addresses', () => {
    // Mealie performs the fetch, so the request originates inside its network.
    for (const url of [
      'http://localhost/a',
      'http://sub.localhost/a',
      'http://127.0.0.1:9000/a',
      'http://127.1.2.3/a',
      'http://0.0.0.0/a',
      'http://10.1.2.3/a',
      'http://192.168.0.7/a',
      'http://172.16.0.1/a',
      'http://172.31.255.254/a',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/a',
      'http://239.1.1.1/a',
      'http://[::1]/a',
      'http://[::]/a',
      'http://[fc00::1]/a',
      'http://[fd12:3456::1]/a',
      'http://[fe80::1]/a',
    ]) {
      expect(httpUrl.safeParse(url).success, url).toBe(false);
    }
  });

  it('rejects every IPv6 literal, including IPv4-mapped forms', () => {
    // `http://[::ffff:127.0.0.1]/` normalises to hostname `[::ffff:7f00:1]`,
    // which no dotted-quad check ever sees — so the guard refuses bracketed
    // literals as a class instead of classifying them piecemeal.
    for (const url of [
      'http://[::ffff:127.0.0.1]/a',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:192.168.0.7]/a',
      'http://[64:ff9b::7f00:1]/a',
      'http://[2001:db8::1]/a',
    ]) {
      expect(httpUrl.safeParse(url).success, url).toBe(false);
    }
  });

  it('rejects internal-only name suffixes', () => {
    for (const url of [
      'http://mealie.lan/a',
      'http://mealie.local/a',
      'http://mealie.internal/a',
      'http://nas.home/a',
      'http://nas.home.arpa/a',
      'https://MEALIE.LAN/a',
    ]) {
      expect(httpUrl.safeParse(url).success, url).toBe(false);
    }
  });

  it('does not reject public addresses that merely look private', () => {
    // 172.32/11.x is public; only 172.16–172.31 is reserved.
    for (const url of [
      'http://172.32.0.1/a',
      'http://172.15.0.1/a',
      'http://11.0.0.1/a',
      'http://100.63.0.1/a',
      'http://100.128.0.1/a',
      'https://mylocal.example.com/a',
      'https://internal-recipes.example.com/a',
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
