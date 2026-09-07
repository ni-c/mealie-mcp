/**
 * Text that came from somewhere else, made safe to put in front of a model.
 *
 * Three sources meet here: what Mealie returns (recipes are scraped from
 * arbitrary websites and stay in the database), what an error body says (a
 * reverse proxy, a WAF, or whatever a mistyped `MEALIE_URL` lands on), and what
 * the operator put in an environment variable next to the secret. None of them
 * is decoration in a model's context: `ESC[1A` moves the cursor up and
 * overwrites what was already there, U+202E reverses the rest of the line, and
 * a zero-width joiner splits a word the reader was told to look for.
 *
 * The character class is built from code points at runtime rather than spelled
 * as escapes in a literal. That is deliberate: editing tools rewrite `\uXXXX` in
 * a replacement into the raw byte, and a raw control byte in a source file is
 * exactly what this module exists to keep out of a result.
 */

/** Ranges (inclusive) of the characters removed from any foreign text. */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], // C0 controls before TAB
  [0x0b, 0x0c], // VT, FF
  [0x0e, 0x1f], // C0 controls after CR
  [0x7f, 0x9f], // DEL and the C1 controls
  [0xad, 0xad], // soft hyphen
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space/joiners, LRM, RLM
  [0x202a, 0x202e], // BiDi embeddings and overrides
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x2069], // BiDi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function classOf(ranges: readonly (readonly [number, number])[]): RegExp {
  const body = ranges
    .map(([from, to]) =>
      from === to
        ? String.fromCodePoint(from)
        : `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`
    )
    .join('');
  return new RegExp(`[${body}]`, 'gu');
}

const UNSAFE = classOf(UNSAFE_RANGES);

/** True when `text` carries none of the characters {@link cleanText} removes. */
export function isClean(text: string): boolean {
  UNSAFE.lastIndex = 0;
  return !UNSAFE.test(text);
}

/**
 * Strips the unsafe characters and bounds the length, saying so in the value.
 *
 * Newline and tab survive: a recipe step is prose and prose has paragraphs. The
 * cut is announced in the value itself rather than silently, because the reader
 * is a model that would otherwise take the fragment for the whole.
 */
export function cleanText(text: string, max: number): string {
  const clean = text.replace(UNSAFE, '');
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}… (truncated at ${max} characters)`;
}

/**
 * A sentence's worth of text the instance wrote, labelled as such.
 *
 * For error bodies and messages quoted into a result. The label is what tells
 * the model — and the person reading over its shoulder — that the words that
 * follow are the upstream's, not this server's.
 */
export function upstreamText(text: string, max = 200): string {
  const trimmed = text.trim();
  if (/^(<!doctype|<html[\s>]|<\?xml|<!--)/i.test(trimmed)) {
    return '(HTML error page omitted)';
  }
  const flat = trimmed.replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max)}… (truncated)` : flat;
  return `(untrusted text from the instance): ${cut}`;
}

/**
 * How a configuration value is described in a diagnostic.
 *
 * Quoted only when it is short enough to be a setting rather than a secret;
 * anything longer is described by its length. A token pasted into the wrong
 * variable is exactly what a value that matches nothing looks like.
 */
export function quoted(raw: string, max = 40): string {
  const flat = raw.replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  return flat.length > max
    ? `a value of ${raw.length} characters`
    : `"${flat}"`;
}

/**
 * A URL with any embedded credentials replaced.
 *
 * Matches the userinfo up to the *last* `@` before the path, so
 * `https://a@b:c@host/` loses both halves. A value that is not URL-shaped is
 * returned as it came — this is a redaction, not a validation.
 */
export function redactUrl(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1***@');
}

/**
 * Field names under which a backend stores a credential.
 *
 * Matched on the *suffix* of the normalised key (`_` and `-` removed, lower
 * case) rather than on an exact list: Mealie's `extras` is arbitrary key/value
 * data written by integrations, and `git-password` is not `password` to an
 * exact match. `key` alone is deliberately absent — it would take every `*_key`
 * identifier — and `secret_key` is kept as an exact name for that reason.
 */
const SECRET_SUFFIXES = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'privatekey',
] as const;

const SECRET_EXACT = new Set(['secretkey']);

/** Fields a result legitimately carries under a name that ends like a secret. */
const SECRET_EXEMPT = new Set(['tokens', 'numtokens', 'sharetokens']);

export function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[_-]/g, '');
  if (SECRET_EXEMPT.has(normalised)) return false;
  if (SECRET_EXACT.has(normalised)) return true;
  return SECRET_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

export const REDACTED = '[redacted]';

/** How deep {@link cleanDeep} follows a value before it stops copying. */
const MAX_DEPTH = 32;

/**
 * A copy of `value` with every string cleaned and every secret-shaped field
 * redacted, at any depth.
 *
 * Objects are rebuilt with `Object.fromEntries`, which defines every key as an
 * own property — `out[key] = …` with a key of `__proto__` would set the
 * prototype and drop the field instead. Past {@link MAX_DEPTH} the value is
 * replaced by a sentence rather than copied, so a pathological nesting cannot
 * exhaust the stack.
 */
export function cleanDeep(value: unknown, maxString: number): unknown {
  return walk(value, maxString, 0);
}

function walk(value: unknown, maxString: number, depth: number): unknown {
  if (typeof value === 'string') return cleanText(value, maxString);
  // What the text block will say, said in the structured half too: `1e999`
  // parses to Infinity and serialises to `null`, and `-0` serialises to `0`.
  // Either would split the two channels of one answer.
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value + 0 : null;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '(nested too deeply; omitted)';
  if (Array.isArray(value)) {
    return value.map((entry) => walk(entry, maxString, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      cleanText(key, 200),
      isSecretKey(key) && entry !== null && entry !== undefined
        ? REDACTED
        : walk(entry, maxString, depth + 1),
    ])
  );
}
