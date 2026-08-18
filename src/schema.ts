import { z } from 'zod';

/** Upper bound for every paginated tool, so one call cannot flood the context. */
export const MAX_PER_PAGE = 100;

export const pageParam = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('1-based page number, default 1');

export function perPageParam(defaultPerPage: number) {
  return z
    .number()
    .int()
    .min(1)
    .max(MAX_PER_PAGE)
    .optional()
    .describe(
      `Number of entries to return, default ${defaultPerPage}, max ${MAX_PER_PAGE}`
    );
}

export const orderDirectionParam = z
  .enum(['asc', 'desc'])
  .optional()
  .describe('Sort direction, default desc');

export const confirmTokenParam = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Confirmation token from a previous call of this tool with the same arguments. Omit on the first call.'
  );

/** A Mealie UUID. Everything except recipes is addressed by one. */
export const uuidParam = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'must be a UUID'
  );

/**
 * A recipe slug — Mealie's kebab-case identifier derived from the name, and the
 * only way recipe CRUD addresses a recipe.
 */
export const slugParam = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'must be a Mealie slug: lowercase letters, digits and single hyphens'
  );

/**
 * A reference to a recipe.
 *
 * Mealie's identifier space is split: recipe CRUD is addressed by slug, while
 * meal plans, shopping-list recipe references, ratings and timeline events use
 * the UUID. `GET /api/recipes/{…}` resolves either, so tools take either and
 * resolve internally rather than making the caller keep track.
 */
export const recipeRefParam = z
  .union([slugParam, uuidParam])
  .describe(
    'Recipe slug (e.g. "quark-bowl") or recipe UUID — both are returned by search_recipes'
  );

/** An ISO calendar date, `YYYY-MM-DD`, as the meal plan endpoints expect. */
export const dateParam = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD form')
  .refine((value) => {
    // Not `Date.parse` alone: V8 rolls an impossible date over instead of
    // failing, so "2026-02-30" parses happily and lands on 2 March. Round-trip
    // the components to reject it.
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, 'must be a valid calendar date');

/** Hosts that no recipe legitimately lives on. */
function isNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal') ||
    host.endsWith('.home') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }

  // Any IPv6 literal is refused outright. Classifying them piecemeal is a
  // losing game: beyond loopback, unique-local and link-local there are the
  // IPv4-mapped forms (`::ffff:127.0.0.1` normalises to `::ffff:7f00:1`, which
  // a dotted-quad check never sees), NAT64 prefixes and other embeddings that
  // smuggle a private IPv4 address past the guard. No recipe is published on a
  // bracketed address literal, so rejecting the whole class costs nothing.
  if (host.includes(':')) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
  }

  return false;
}

/**
 * A URL that Mealie will be asked to fetch server-side.
 *
 * Two separate problems, both closed here at the input:
 *
 * Zod's own `.url()` only checks that `new URL()` parses the value, so it
 * accepts `javascript:`, `file:`, `data:` and `ftp:` just as happily as
 * `https:`. Every URL validated by this schema is handed to Mealie, which
 * fetches it with its own scraper (`import_recipe_from_url`,
 * `preview_recipe_url`, `scrape_recipe_image`) — so an unrestricted scheme is a
 * file-disclosure primitive assembled out of valid tool calls.
 *
 * And because Mealie does the fetching, the request originates *inside* the
 * network the instance runs on. A model that picked up an injected instruction
 * out of a scraped recipe could otherwise use this server to probe the home LAN
 * or a cloud metadata endpoint. Recipes do not live on private addresses, so
 * refusing them costs nothing.
 *
 * This is not a complete SSRF defence — it cannot be, since the name is
 * resolved by Mealie and a public name can point at a private address. It
 * removes the trivial paths; the real boundary is Mealie's own network egress.
 */
export const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'must be an absolute http:// or https:// URL',
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        message: `must use http:// or https:// (got ${parsed.protocol})`,
      });
      return;
    }
    if (isNonPublicHost(parsed.hostname)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'refusing a loopback, private-range or link-local host — Mealie would ' +
          'fetch this from inside its own network',
      });
    }
  });
