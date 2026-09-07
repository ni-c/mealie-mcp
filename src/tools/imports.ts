import { z } from 'zod';
import { marked } from '../output-schema.js';
import type { McpServer } from '@modelcontextprotocol/server';

import { LONG_TIMEOUT_MS, query, type MealieApi } from '../api.js';
import { READ_ONLY, WRITE } from './annotations.js';
import type { Config } from '../config.js';
import { run, ToolInputError, untrustedResult } from '../result.js';
import { assertFetchableUrl, httpUrl } from '../schema.js';
import { recipeDetail } from '../shape.js';
import { cleanText } from '../text.js';

/**
 * Cap on an inline HTML or image payload.
 *
 * These two tools are the only ones that take bulk data *into* the server, and
 * both of them forward it. 2 MB of HTML is more than any recipe page, and a
 * base64 photo of a cookbook page is a few hundred kB — the limit exists so a
 * runaway argument cannot be turned into memory pressure or a multi-megabyte
 * upload.
 */
const MAX_HTML_CHARS = 2 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;

const IMAGE_MIME_TYPES = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

export function registerImportReadTools(
  server: McpServer,
  api: MealieApi
): void {
  server.registerTool(
    'preview_recipe_url',
    {
      title: 'Preview a recipe URL',
      description:
        'Fetches a URL and reports what Mealie would extract from it, WITHOUT ' +
        'saving anything. Use this to check a page before importing it, or to ' +
        'find out why an import came out empty.',
      inputSchema: z.object({
        url: httpUrl.describe('Address of the recipe page to test'),
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
      outputSchema: marked(),
    },
    async ({ url }) =>
      run(async () => {
        // The parsed URL, not the argument: the address that was checked has
        // to be the address Mealie fetches.
        const data = await api.post(
          '/api/recipes/test-scrape-url',
          { url: await assertFetchableUrl(url) },
          LONG_TIMEOUT_MS
        );
        return untrustedResult(data);
      })
  );
}

export function registerImportTools(
  server: McpServer,
  api: MealieApi,
  config: Config
): void {
  server.registerTool(
    'import_recipe_from_url',
    {
      title: 'Import recipe from URL',
      description:
        'Has Mealie fetch a recipe page and save it as a new recipe. The fetch ' +
        'happens on the Mealie server, not here. Everything the page contains — ' +
        'name, description, ingredients, steps — ends up in the collection as ' +
        'written by whoever controls that site.',
      inputSchema: z.object({
        url: httpUrl.describe('Address of the recipe to import'),
        include_tags: z
          .boolean()
          .optional()
          .describe("Adopt the page's keywords as tags, default false"),
        include_categories: z.boolean().optional(),
      }),
      annotations: { ...WRITE, openWorldHint: true },
      outputSchema: marked(),
    },
    async ({ url, include_tags, include_categories }) =>
      run(async () => {
        const data = await api.post(
          '/api/recipes/create/url',
          {
            url: await assertFetchableUrl(url),
            includeTags: include_tags ?? false,
            includeCategories: include_categories ?? false,
          },
          LONG_TIMEOUT_MS
        );
        return untrustedResult(await expand(api, config, data));
      })
  );

  server.registerTool(
    'import_recipe_from_html_or_json',
    {
      title: 'Import recipe from HTML or JSON',
      description:
        'Creates a recipe from HTML or schema.org recipe JSON supplied directly, ' +
        'so Mealie does not fetch the page. Useful for a page that needs a login, ' +
        'or one that import_recipe_from_url could not parse.\n\n' +
        'It does not fetch the *page*, but it is not fetch-free: Mealie reads the ' +
        'image address out of the document and retrieves that. Every such address ' +
        'this server can find is checked before the document is handed over, and ' +
        'an internal one is refused — but a document can hide an address in ways ' +
        'a scan does not see, so do not paste one from a source you would not let ' +
        'Mealie make a request for.',
      inputSchema: z.object({
        data: z
          .string()
          .min(1)
          .max(MAX_HTML_CHARS)
          .describe('The page HTML, or a schema.org Recipe JSON document'),
      }),
      // openWorldHint, despite the name of the tool: the document is not
      // fetched, but Mealie makes a request of its own out of what is in it.
      // Verified on v3.22.0 — a document with
      // `"image": "http://<host>:9932/latest/meta-data/"` produces
      // `Image URL: …` in Mealie's log and a call to
      // `recipe_data_service.scrape_image`. A client or policy layer that reads
      // this hint was being told the opposite of what happens.
      annotations: { ...WRITE, openWorldHint: true },
      outputSchema: marked(),
    },
    async ({ data }) =>
      run(async () => {
        // Mealie has a guard of its own here and it is not the same guard:
        // `safehttp.transport` refuses an address whose IP is `is_private`,
        // which in CPython is False for 100.100.100.200 — the Alibaba metadata
        // service — and for the whole of 100.64.0.0/10. `assertFetchableUrl`
        // classifies that address as link-local and refuses it, so running the
        // extracted addresses through it closes the part Mealie leaves open.
        for (const url of imageUrlsIn(data)) {
          await assertFetchableUrl(url);
        }
        const created = await api.post(
          '/api/recipes/create/html-or-json',
          { data },
          LONG_TIMEOUT_MS
        );
        return untrustedResult(await expand(api, config, created));
      })
  );

  server.registerTool(
    'import_recipe_from_image',
    {
      title: 'Import recipe from image',
      description:
        'Creates a recipe from a photo of one — a cookbook page, a handwritten ' +
        'card — by having Mealie run it through its configured AI provider. ' +
        'Requires an AI provider set up in Mealie; without one the call fails, ' +
        'and the setting itself is only visible to a group manager or admin.',
      inputSchema: z.object({
        image_base64: z
          .string()
          .min(1)
          .max(MAX_IMAGE_BASE64_CHARS)
          .describe('The image, base64-encoded, without a data: URI prefix'),
        format: z
          .enum(['jpeg', 'jpg', 'png', 'webp'])
          .describe(
            'Image format, used for the upload filename and content type'
          ),
        translate_language: z
          .string()
          .trim()
          .min(2)
          .max(35)
          .optional()
          .describe(
            'Translate the extracted recipe into this language, e.g. "de" or "German"'
          ),
      }),
      annotations: { ...WRITE, openWorldHint: true },
      outputSchema: marked(),
    },
    async ({ image_base64, format, translate_language }) =>
      run(async () => {
        const bytes = decodeBase64(image_base64);
        const form = new FormData();
        form.append(
          'images',
          new Blob([bytes as unknown as ArrayBuffer], {
            type: IMAGE_MIME_TYPES[format],
          }),
          `recipe.${format}`
        );
        const created = await api.post(
          `/api/recipes/create/image${query({
            translateLanguage: translate_language,
          })}`,
          form,
          LONG_TIMEOUT_MS
        );
        return untrustedResult(await expand(api, config, created));
      })
  );
}

/**
 * How many distinct hosts an inline document may point at. Each one costs a
 * name resolution, and a recipe page that names more than a handful of image
 * hosts is not a recipe page. The 26th host is a refusal, not a silent skip:
 * an address the scan did not check is an address Mealie fetches unchecked.
 */
const MAX_IMAGE_HOSTS = 25;

/**
 * How many image references the scan reads before it refuses the document.
 *
 * This is the bound on the work a document can buy. The scan itself is one
 * pass — every character is visited a constant number of times — but each
 * reference costs a decode and a URL parse, and a document that is nothing but
 * `"image":[` two hundred thousand times over is not a recipe. It used to cost
 * 223 seconds on the thread that serves every request.
 */
const MAX_IMAGE_CANDIDATES = 500;

/** The longest tag the HTML scan reads before giving up on finding its `>`. */
const MAX_TAG_LENGTH = 2000;

/** The schema.org keys whose value Mealie reads an image address out of. */
const IMAGE_KEYS = new Set(['image', 'thumbnailurl', 'contenturl']);

/**
 * Absolute http(s) addresses in `document` that Mealie may fetch as an image.
 *
 * The document is "HTML or JSON", in practice often a fragment of one pasted
 * into the other, so it is read three ways and the union is checked:
 *
 *  - As JSON, when it parses: the object is walked and every string under an
 *    `image`, `thumbnailUrl` or `contentUrl` key is taken, at any depth. This
 *    is the reading that cannot be fooled by how a key is spelled — Mealie's
 *    parser turns `"image"` into `image`, and so does this one.
 *  - As JSON text, always: string literals are read one after another with
 *    their escapes decoded, so `"http:\/\/…"` — which PHP's `json_encode`
 *    writes by default — is the address it decodes to, not the `http:` a
 *    reader that stops at the backslash would see. The keys of JSON-LD blocks
 *    inside HTML are found this way too.
 *  - As HTML: `<img src>`, `<meta>` with `og:image`, `twitter:image` or
 *    `itemprop="image"`, and `<link>` with `rel="image_src"` or
 *    `itemprop="image"` — the places extruct and recipe_scrapers read for
 *    Mealie — with character references decoded the way an HTML parser decodes
 *    them, every digit of `&#0000000049;` included.
 *
 * Only absolute `http:`/`https:` values are returned. A relative `src` is not
 * something Mealie can resolve out of a document with no base, and a `data:`
 * image — which is common — would otherwise be refused by `assertFetchableUrl`
 * for its scheme and turn a working import into an error. An absolute address
 * that names a scheme and still does not parse is refused rather than ignored:
 * "cannot parse" is not "harmless" when the next parser is somebody else's.
 *
 * One address per host: the check is about which host is contacted, and a page
 * with forty images on one CDN should cost one lookup rather than forty.
 *
 * Throws `ToolInputError` when the document points at more hosts or carries
 * more references than a recipe page does, or names an address that cannot be
 * parsed — every one of those is a document this server will not hand on.
 */
export function imageUrlsIn(document: string): string[] {
  const scan = new ImageScan();
  const trimmed = document.trimStart();
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');

  if (looksLikeJson) {
    let parsed: unknown;
    let ok = false;
    try {
      parsed = JSON.parse(document) as unknown;
      ok = true;
    } catch {
      // Not JSON to this parser. Python's accepts `NaN` and `Infinity` where
      // this one does not, so the text reading below still applies.
    }
    if (ok) {
      scan.walkJson(parsed);
      return scan.urls();
    }
  }

  scan.scanJsonText(document);
  if (!looksLikeJson) {
    scan.scanScripts(document);
    scan.scanTags(document);
  }
  return scan.urls();
}

class ImageScan {
  private readonly found = new Map<string, string>();
  private candidates = 0;

  urls(): string[] {
    return [...this.found.values()];
  }

  /** One image reference read; the document is refused past the ceiling. */
  private count(): void {
    this.candidates += 1;
    if (this.candidates > MAX_IMAGE_CANDIDATES) {
      throw new ToolInputError(
        `the document carries more than ${MAX_IMAGE_CANDIDATES} image references. ` +
          'A recipe page does not, and every reference is an address Mealie ' +
          'may fetch — pass a document that contains the recipe, not the site.'
      );
    }
  }

  /**
   * One decoded value that may be an address. Relative values and non-http
   * schemes are left alone; an absolute value that does not parse is refused.
   */
  private consider(raw: string): void {
    this.count();
    const value = raw.trim();
    const absolute =
      /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
    if (!absolute) return;
    let parsed: URL;
    try {
      parsed = new URL(value.startsWith('//') ? `https:${value}` : value);
    } catch {
      throw new ToolInputError(
        `the document names an address this server cannot parse (${cleanText(value, 80)}). ` +
          'Mealie would read it its own way, so it is refused rather than passed on.'
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    if (this.found.has(parsed.hostname)) return;
    if (this.found.size >= MAX_IMAGE_HOSTS) {
      throw new ToolInputError(
        `the document points at more than ${MAX_IMAGE_HOSTS} different hosts. ` +
          'A recipe page does not; pass a document that contains the recipe, not the site.'
      );
    }
    this.found.set(parsed.hostname, parsed.href);
  }

  /** Every string anywhere under an image key of a parsed JSON value. */
  walkJson(root: unknown): void {
    // An explicit queue rather than recursion: the parser accepts nesting far
    // deeper than the call stack would. Breadth-first, so the addresses come
    // out in document order.
    const queue: { value: unknown; inImage: boolean }[] = [
      { value: root, inImage: false },
    ];
    for (let head = 0; head < queue.length; head += 1) {
      const { value, inImage } = queue[head]!;
      if (typeof value === 'string') {
        if (inImage) this.consider(value);
        continue;
      }
      if (value === null || typeof value !== 'object') continue;
      if (Array.isArray(value)) {
        for (const entry of value) queue.push({ value: entry, inImage });
        continue;
      }
      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>
      )) {
        queue.push({
          value: entry,
          inImage: inImage || IMAGE_KEYS.has(key.toLowerCase()),
        });
      }
    }
  }

  /**
   * Reads `text` as a sequence of JSON string literals and takes the value
   * region after every image key. Each character is visited once: the cursor
   * only ever moves forward, past whatever was just read.
   */
  scanJsonText(text: string): void {
    let cursor = 0;
    for (;;) {
      const open = text.indexOf('"', cursor);
      if (open === -1) return;
      const literal = readLiteral(text, open);
      cursor = literal.end;
      if (!IMAGE_KEYS.has(literal.value.toLowerCase())) continue;
      const colon = skipWhitespace(text, cursor);
      if (text[colon] !== ':') continue;
      cursor = this.readImageValue(text, skipWhitespace(text, colon + 1));
    }
  }

  /**
   * The value after an image key: a string, or every string inside the array
   * or object that follows, up to its matching close. Returns where reading
   * stopped, so the caller continues from there.
   */
  private readImageValue(text: string, start: number): number {
    const first = text[start];
    if (first === '"') {
      const literal = readLiteral(text, start);
      this.consider(literal.value);
      return literal.end;
    }
    if (first !== '[' && first !== '{') return start;
    let depth = 0;
    let cursor = start;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === '"') {
        const literal = readLiteral(text, cursor);
        this.consider(literal.value);
        cursor = literal.end;
        continue;
      }
      if (char === '[' || char === '{') depth += 1;
      if (char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) return cursor + 1;
      }
      cursor += 1;
    }
    return cursor;
  }

  /** JSON-LD blocks inside HTML, read as JSON on their own. */
  scanScripts(html: string): void {
    const opener = /<script\b/gi;
    for (;;) {
      const match = opener.exec(html);
      if (match === null) return;
      const tagEnd = tagEndOf(html, match.index);
      const tag = html.slice(match.index, tagEnd);
      const close = html.indexOf('</script', tagEnd);
      const bodyEnd = close === -1 ? html.length : close;
      opener.lastIndex = bodyEnd;
      if (!/ld\+json/i.test(tag)) continue;
      const body = html.slice(tagEnd, bodyEnd);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        this.scanJsonText(body);
        continue;
      }
      this.walkJson(parsed);
    }
  }

  /** `<img>`, `<meta>` and `<link>` tags, each read once and skipped past. */
  scanTags(html: string): void {
    const opener = /<(img|meta|link)\b/gi;
    for (;;) {
      const match = opener.exec(html);
      if (match === null) return;
      const end = tagEndOf(html, match.index);
      opener.lastIndex = end;
      const tag = html.slice(match.index, end);
      const kind = match[1]!.toLowerCase();
      let value: string | undefined;
      if (kind === 'img') {
        value = attribute(tag, 'src');
      } else if (kind === 'meta') {
        if (!/og:image|twitter:image|itemprop\s*=\s*["']?image\b/i.test(tag))
          continue;
        value = attribute(tag, 'content');
      } else {
        if (
          !/rel\s*=\s*["']?image_src\b|itemprop\s*=\s*["']?image\b/i.test(tag)
        )
          continue;
        value = attribute(tag, 'href');
      }
      if (value !== undefined) this.consider(decodeEntities(value));
    }
  }
}

/** Where a tag that opens at `start` ends: after its `>`, or after the cap. */
function tagEndOf(html: string, start: number): number {
  const close = html.indexOf('>', start);
  const limit = start + MAX_TAG_LENGTH;
  return close === -1 || close >= limit
    ? Math.min(limit, html.length)
    : close + 1;
}

/** The value of `name="…"`, `name='…'` or `name=bare` inside one tag. */
function attribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]{0,2048})"|'([^']{0,2048})'|([^\\s"'>]{1,2048}))`,
    'i'
  );
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function skipWhitespace(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
  return cursor;
}

/**
 * The string literal opening at `text[open] === '"'`, decoded.
 *
 * Escapes are followed rather than treated as terminators, and the raw body
 * is handed to `JSON.parse` so every escape means what it means to a JSON
 * parser. A body the parser refuses — a raw control character, a lone
 * surrogate escape — is used as written, which is what a lenient reader on the
 * other side would see too. `end` is the index after the closing quote, or
 * the end of the text when the literal never closes.
 */
function readLiteral(
  text: string,
  open: number
): { value: string; end: number } {
  let cursor = open + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === '"') break;
    cursor += 1;
  }
  const raw = text.slice(open + 1, Math.min(cursor, text.length));
  const end = Math.min(cursor + 1, text.length);
  if (!raw.includes('\\')) return { value: raw, end };
  try {
    return { value: JSON.parse(`"${raw}"`) as string, end };
  } catch {
    return { value: raw, end };
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decodes character references the way an HTML tokenizer does: every digit of
 * a numeric reference, with or without the semicolon, in one alternation — so
 * `&#x26;#104;` is decoded once, not twice. Zero, a surrogate and anything past
 * U+10FFFF become U+FFFD, a character rather than nothing: `''` would make
 * `&#0;` an invisible separator.
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));?/g,
    (whole, decimal: string | undefined, hex: string | undefined, named) => {
      if (named !== undefined) {
        const known = Object.hasOwn(NAMED_ENTITIES, named as string)
          ? NAMED_ENTITIES[named as string]
          : undefined;
        return known ?? whole;
      }
      const digits = (decimal ?? hex ?? '').replace(/^0+/, '');
      // Past twenty digits the value is out of range whatever it says, and
      // `parseInt` on a longer run would only find that out more slowly.
      const point =
        digits.length > 8
          ? Infinity
          : parseInt(digits || '0', decimal ? 10 : 16);
      if (
        !Number.isFinite(point) ||
        point === 0 ||
        point > 0x10ffff ||
        (point >= 0xd800 && point <= 0xdfff)
      ) {
        return String.fromCodePoint(0xfffd);
      }
      return String.fromCodePoint(point);
    }
  );
}

/** Strict base64 decode: a malformed argument must not reach Mealie as garbage. */
function decodeBase64(value: string): Buffer {
  const cleaned = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new ToolInputError(
      'image_base64 is not valid base64. Pass the raw encoding without a "data:" prefix.'
    );
  }
  return Buffer.from(cleaned, 'base64');
}

/**
 * Turns the result of an import into the full recipe.
 *
 * The create routes answer with the new slug as a bare JSON string rather than
 * with the record, so without this second call every import would report nothing
 * but a slug and the model would have to guess that `get_recipe` is next.
 */
async function expand(
  api: MealieApi,
  config: Config,
  created: unknown
): Promise<Record<string, unknown>> {
  if (
    typeof created === 'string' &&
    /^[A-Za-z0-9._-]+$/.test(created) &&
    // Same rule as assertPathSegment: the character class alone admits the two
    // dot-only segments, and an upstream answering ".." would turn the request
    // into `/api/recipes/..`.
    created !== '.' &&
    created !== '..'
  ) {
    return recipeDetail(await api.get(`/api/recipes/${created}`), config.url);
  }
  return recipeDetail(created, config.url);
}
