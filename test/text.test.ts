import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  cleanDeep,
  cleanText,
  isClean,
  isSecretKey,
  quoted,
  REDACTED,
  redactUrl,
  upstreamText,
} from '../src/text.js';

/**
 * Every character these tests need is built at runtime. A control byte
 * spelled into a source file is what the module exists to keep out of a
 * result, and the tools that edit files turn an escape into the byte.
 */
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);
const NEL = String.fromCodePoint(0x85);

describe('cleanText', () => {
  it('removes controls, DEL, C1, the zero-width set and BiDi overrides', () => {
    const dirty = `a${ESC}[1Ab${NUL}c${RLO}d${ZWSP}e${BOM}f${NEL}g`;
    expect(cleanText(dirty, 100)).toBe('a[1Abcdefg');
  });

  it('keeps newline and tab: recipe steps are prose', () => {
    expect(cleanText('step one\n\tstep two', 100)).toBe('step one\n\tstep two');
  });

  it('cuts and says so in the value', () => {
    expect(cleanText('x'.repeat(50), 10)).toBe(
      'xxxxxxxxxx… (truncated at 10 characters)'
    );
    expect(cleanText('x'.repeat(10), 10)).toBe('x'.repeat(10));
  });

  it('never leaves a character of the class behind', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300, unit: 'binary' }),
        fc.integer({ min: 1, max: 400 }),
        (text, max) => {
          const clean = cleanText(text, max);
          expect(isClean(clean)).toBe(true);
          expect(clean.length).toBeLessThanOrEqual(max + 40);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: 'binary' }), (text) => {
        const once = cleanText(text, 1000);
        expect(cleanText(once, 1000)).toBe(once);
      }),
      { numRuns: 500 }
    );
  });
});

describe('upstreamText', () => {
  it('labels the text as the instance’s and flattens it', () => {
    expect(upstreamText(`  {"detail":\n"x"}  ${ESC}`)).toBe(
      '(untrusted text from the instance): {"detail": "x"}'
    );
  });

  it('drops an HTML page whole', () => {
    expect(upstreamText('<!DOCTYPE html><html>…')).toBe(
      '(HTML error page omitted)'
    );
  });

  it('cuts at the given length', () => {
    const text = upstreamText('y'.repeat(500), 50);
    expect(text).toContain('… (truncated)');
    expect(text.length).toBeLessThan(120);
  });
});

describe('quoted', () => {
  it('quotes a short setting and describes a long one by its length', () => {
    expect(quoted('yes')).toBe('"yes"');
    expect(quoted(`ye${ESC}s`)).toBe('"yes"');
    const jwt = `eyJ${'a'.repeat(120)}.${'b'.repeat(120)}`;
    expect(quoted(jwt)).toBe(`a value of ${jwt.length} characters`);
    expect(quoted(jwt)).not.toContain('eyJ');
  });
});

describe('redactUrl', () => {
  it('replaces the userinfo up to the last @ before the path', () => {
    expect(redactUrl('https://user:pass@host.example/r')).toBe(
      'https://***@host.example/r'
    );
    expect(redactUrl('https://a@b:c@host.example/r?x=1')).toBe(
      'https://***@host.example/r?x=1'
    );
    // An `@` in the path or query is not credentials.
    expect(redactUrl('https://host.example/r?mail=a@b')).toBe(
      'https://host.example/r?mail=a@b'
    );
    expect(redactUrl('not a url')).toBe('not a url');
  });
});

describe('isSecretKey', () => {
  it('matches on the suffix of the normalised name', () => {
    for (const key of [
      'password',
      'git-password',
      'gitPassword',
      'GIT_PASSWORD',
      'oauth_client_secret',
      'apiKey',
      'api-key',
      'access_token',
      'secret_key',
      'private-key',
      'passphrase',
      'passwd',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('leaves the neighbours alone', () => {
    for (const key of [
      'tokens',
      'numTokens',
      'token_invalidated',
      'secrets',
      'password_reset_at',
      'ssh_key',
      'key',
      'id',
      'name',
      'username',
    ]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it('holds over any prefix, separator and casing', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{0,8}$/),
        fc.constantFrom('', '_', '-'),
        fc.constantFrom(
          'password',
          'secret',
          'token',
          'apiKey',
          'privateKey',
          'passphrase',
          'passwd'
        ),
        fc.boolean(),
        (prefix, separator, suffix, upper) => {
          const key = `${prefix}${prefix ? separator : ''}${suffix}`;
          expect(isSecretKey(upper ? key.toUpperCase() : key)).toBe(true);
        }
      ),
      { numRuns: 500 }
    );
  });
});

describe('cleanDeep', () => {
  it('cleans every string at any depth and redacts secret-shaped fields', () => {
    const value = {
      name: `Quark${ESC}[2J`,
      extras: { 'git-password': 'hunter2', 'git-username': 'ava', n: 1 },
      steps: [{ text: `one${RLO}` }, [`two${NUL}`]],
      nothing: null,
      token: null,
    };
    expect(cleanDeep(value, 100)).toEqual({
      name: 'Quark[2J',
      extras: { 'git-password': REDACTED, 'git-username': 'ava', n: 1 },
      steps: [{ text: 'one' }, ['two']],
      nothing: null,
      token: null,
    });
  });

  it('cuts a string past the raw ceiling', () => {
    const out = cleanDeep({ calories: 'x'.repeat(30_000) }, 20_000) as {
      calories: string;
    };
    expect(out.calories.length).toBeLessThan(20_100);
    expect(out.calories).toContain('(truncated at 20000 characters)');
  });

  it('keeps a __proto__ key as an own property and cleans the key itself', () => {
    const parsed = JSON.parse(
      `{"__proto__": "x", "a${'\\u001b'}b": 1}`
    ) as Record<string, unknown>;
    const out = cleanDeep(parsed, 100) as Record<string, unknown>;
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, 'ab')).toBe(true);
  });

  it('stops at a depth no recipe has', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 60; i += 1) deep = [deep];
    expect(JSON.stringify(cleanDeep(deep, 100))).toContain('nested too deeply');
  });

  it('never returns a string with a character of the class', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        const text = JSON.stringify(cleanDeep(value, 500));
        expect(isClean(JSON.parse(text) === null ? '' : text)).toBe(true);
      }),
      { numRuns: 300 }
    );
  });
});
