import { z } from 'zod';

import { firstInternalAddress } from './hosts.js';
import { ToolInputError } from './result.js';

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

/**
 * A URL that Mealie will be asked to fetch server-side.
 *
 * Zod's own `.url()` only checks that `new URL()` parses the value, so it
 * accepts `javascript:`, `file:`, `data:` and `ftp:` just as happily as
 * `https:`. Every URL validated by this schema is handed to Mealie, which
 * fetches it with its own scraper (`import_recipe_from_url`,
 * `preview_recipe_url`) — so an unrestricted scheme is a file-disclosure
 * primitive assembled out of valid tool calls.
 *
 * The *host* is checked separately, by `assertFetchableUrl` in the tool
 * handlers: that check resolves names, which a Zod refinement cannot do because
 * it is synchronous. This schema is the early, cheap half — it gives the model
 * a useful error before any work happens — and it is not the boundary.
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
    }
  });

/**
 * Validates a URL Mealie will be asked to fetch, and returns the form that
 * should be sent.
 *
 * `preview_recipe_url` and `import_recipe_from_url` both hand the URL to
 * *Mealie*, which fetches it with its own scraper and returns what it extracted
 * — so the request originates inside Mealie's network and its response comes
 * back to the caller. That is reachable from an instruction injected into a
 * recipe page the model was asked to read.
 *
 * The returned string is the parsed URL, not the input. Handing on the original
 * would mean checking one thing and fetching another: the host of
 * `http://ok.example.com\@127.0.0.1/` is `ok.example.com` to a URL parser and
 * `127.0.0.1` to a fetcher that splits at the `@`.
 *
 * This lives here rather than next to the classifier so that `hosts.ts` stays a
 * leaf module: `config.ts` needs the classifier, and everything that reports a
 * tool error needs `result.ts`, which reaches `config.ts` in turn.
 */
export async function assertFetchableUrl(value: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ToolInputError(`not a valid URL: ${value.slice(0, 200)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolInputError(
      `refusing ${parsed.protocol} — only http:// and https:// recipes can be ` +
        'fetched. Mealie opens the URL with its own scraper, so a file:// or ' +
        'similar scheme would have it read from its own disk instead of a page.'
    );
  }

  const internal = await firstInternalAddress(parsed.hostname);
  if (internal !== null) {
    const where =
      internal.address === parsed.hostname.toLowerCase()
        ? internal.address
        : `${parsed.hostname} (${internal.address})`;
    throw new ToolInputError(
      `refusing to point Mealie at ${where}: that is a ${internal.kind} address. ` +
        'Mealie fetches the URL itself and hands back what it read, so loopback ' +
        'and link-local addresses — the server itself and its cloud metadata ' +
        'service — are not recipe sources. Use a routable URL.'
    );
  }
  return parsed.toString();
}
