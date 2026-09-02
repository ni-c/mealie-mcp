import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import { LONG_TIMEOUT_MS, query, type MealieApi } from '../api.js';
import { READ_ONLY, WRITE } from './annotations.js';
import type { Config } from '../config.js';
import { run, ToolInputError, untrustedResult } from '../result.js';
import { assertFetchableUrl, httpUrl } from '../schema.js';
import { recipeDetail } from '../shape.js';

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
 * How many distinct hosts an inline document may point at before this stops
 * looking. Each one costs a name resolution, and a recipe page that names more
 * than a handful of image hosts is not a recipe page.
 */
const MAX_IMAGE_HOSTS = 25;

/** The length of the value region scanned after an `image:` key. */
const IMAGE_VALUE_WINDOW = 4096;

/**
 * Absolute http(s) addresses in `document` that Mealie may fetch as an image.
 *
 * Deliberately not a parser. The argument is "HTML or JSON", in practice often
 * a fragment of one pasted into the other, and a parser that rejects what it
 * cannot read would refuse documents Mealie imports happily. This scans, and
 * what it finds is checked; what it misses is what the tool description warns
 * about.
 *
 * Only absolute `http:`/`https:` values are returned. A relative `src` is not
 * something Mealie can resolve out of a document with no base, and a
 * `data:` image — which is common — would otherwise be refused by
 * `assertFetchableUrl` for its scheme and turn a working import into an error.
 *
 * One address per host: the check is about which host is contacted, and a page
 * with forty images on one CDN should cost one lookup rather than forty.
 */
export function imageUrlsIn(document: string): string[] {
  const found = new Map<string, string>();

  const consider = (raw: string | undefined): void => {
    if (raw === undefined || found.size >= MAX_IMAGE_HOSTS) return;
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    if (!found.has(parsed.hostname)) found.set(parsed.hostname, parsed.href);
  };

  // schema.org, in every shape it takes: a string, an array of strings, or an
  // ImageObject whose `url` carries the address.
  const keys = /"(?:image|thumbnailUrl|contentUrl)"\s*:\s*/gi;
  for (const key of document.matchAll(keys)) {
    const window = document.slice(
      key.index + key[0].length,
      key.index + key[0].length + IMAGE_VALUE_WINDOW
    );
    if (window.startsWith('"')) {
      consider(/^"([^"\\]*)"/.exec(window)?.[1]);
      continue;
    }
    // An array or an object: take the quoted strings out of the region up to
    // its close, which over-collects a little and under-collects nothing.
    const end = window.search(/[\]}]/);
    for (const literal of (end === -1 ? window : window.slice(0, end)).matchAll(
      /"([^"\\]*)"/g
    )) {
      consider(literal[1]);
    }
  }

  // HTML. The tags are cut out first and the attributes read out of them
  // separately, so neither pattern nests a quantifier inside another.
  for (const tag of document.matchAll(/<img\b[^>]{0,2000}>/gi)) {
    consider(/\bsrc\s*=\s*["']([^"']{0,2048})["']/i.exec(tag[0])?.[1]);
  }
  for (const tag of document.matchAll(/<meta\b[^>]{0,2000}>/gi)) {
    if (!/og:image|twitter:image/i.test(tag[0])) continue;
    consider(/\bcontent\s*=\s*["']([^"']{0,2048})["']/i.exec(tag[0])?.[1]);
  }

  return [...found.values()];
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
