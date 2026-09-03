import { assertPathSegment, query, type MealieApi } from './api.js';
import { MealieApiError } from './api.js';
import { ToolInputError } from './result.js';

export interface RecipeRef {
  id: string;
  slug: string;
}

/**
 * Resolves a recipe reference to both of its identifiers.
 *
 * `GET /api/recipes/{…}` accepts a slug as well as a UUID (verified against
 * Mealie v3.22.0), so one lookup covers either input. The tools need both
 * halves: CRUD and comments are addressed by slug, meal plans, shopping-list
 * references, ratings and timeline events by UUID.
 */
export async function resolveRecipe(
  api: MealieApi,
  ref: string
): Promise<RecipeRef> {
  const data = await api.get(
    `/api/recipes/${assertPathSegment(ref, 'recipe reference')}`
  );
  const record =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : {};
  const id = typeof record.id === 'string' ? record.id : undefined;
  const slug = typeof record.slug === 'string' ? record.slug : undefined;
  if (id === undefined || slug === undefined) {
    throw new ToolInputError(
      `Mealie did not return a recognisable recipe for "${ref}".`
    );
  }
  return { id, slug };
}

/** Where each kind of recipe organizer lives. */
const ORGANIZER_PATHS = {
  tag: '/api/organizers/tags',
  category: '/api/organizers/categories',
  tool: '/api/organizers/tools',
} as const;

/** The organizers `search_recipes` can filter on. */
export type OrganizerKind = keyof typeof ORGANIZER_PATHS;

/** Mealie's own slug shape — the only non-UUID form its filters understand. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Turns whatever the caller called an organizer into the id Mealie filters on.
 *
 * The read path needs this for a reason the write path does not have: a filter
 * Mealie cannot resolve does not fail, it **disappears**. `_uuids_for_items`
 * looks a non-UUID up as a slug and returns an empty list when nothing matches,
 * and `_build_recipe_filter` then tests `if tags:` — so an empty list is falsy
 * and no filter is attached at all. Verified against v3.22.0:
 * `GET /api/recipes?tags=Weeknight%20Dinner` answers with the whole collection,
 * as does a mistyped slug, with nothing in the response saying so.
 *
 * Names are the common case because that is what a person says and what the
 * tool description used to promise, so they are resolved here rather than
 * refused. Anything that cannot be resolved is a hard error: answering a
 * narrowed question with the unfiltered collection is the one outcome the
 * caller cannot detect.
 *
 * Two lookups, in this order, because neither covers the other:
 *
 *  - `/{path}/slug/{slug}` for a slug-shaped value. Slugs already worked before
 *    this function existed, and they have to keep working — including the ones
 *    the name search cannot find, because Mealie folds accents into the slug
 *    but searches the name: `search=creme-brulee` returns nothing for a tag
 *    called "Crème Brûlée", whose slug is exactly that.
 *  - `?search=` for everything else, matched exactly (case-insensitively) on
 *    name or slug. A fuzzy match would be worse than none: quietly filtering by
 *    a similarly-named tag is not something the caller can see either.
 */
export async function resolveOrganizerIds(
  api: MealieApi,
  kind: OrganizerKind,
  values: readonly string[]
): Promise<string[]> {
  const path = ORGANIZER_PATHS[kind];
  const ids: string[] = [];

  for (const value of values) {
    const wanted = value.trim();
    if (UUID_SHAPE.test(wanted)) {
      ids.push(wanted);
      continue;
    }

    // Only a slug-shaped value goes into the path — a name like "Kid & Family"
    // is not a path segment, and building one out of caller text is how a
    // lookup turns into a request somewhere else.
    const bySlug = SLUG_SHAPE.test(wanted)
      ? await organizerBySlug(api, path, wanted)
      : undefined;
    const found = bySlug ?? (await findOrganizer(api, path, wanted));
    const id = (found as Record<string, unknown> | undefined)?.id;
    if (typeof id !== 'string') {
      throw new ToolInputError(
        `No ${kind} in this Mealie is called "${wanted.slice(0, 100)}". ` +
          'Mealie matches these filters on id and slug only, and drops a filter ' +
          'it cannot resolve without saying so — which would answer this ' +
          'narrowed search with the whole collection. Use list_organizers to ' +
          `see the ${kind}s that exist.`
      );
    }
    ids.push(id);
  }

  return ids;
}

/**
 * How Mealie answers "no such slug" on the three organizer slug routes.
 *
 * It answers it two different ways, which is a bug in Mealie rather than a
 * distinction worth honouring. Measured on v3.22.0:
 *
 *   GET /api/organizers/categories/slug/nope-nope -> 404 {"detail": …}
 *   GET /api/organizers/tags/slug/nope-nope       -> 500 Internal Server Error
 *   GET /api/organizers/tools/slug/nope-nope      -> 500 Internal Server Error
 *
 * So a 500 has to be read as "not here" too. That is safe in this one place and
 * only here: this lookup is the *first* of two, and the name search runs
 * afterwards. If the 500 really was Mealie failing rather than Mealie's missing
 * 404, the second request fails as well and the caller is told — nothing is
 * quietly reported as resolved.
 */
const SLUG_ROUTE_MISS = new Set([404, 500]);

async function organizerBySlug(
  api: MealieApi,
  path: string,
  slug: string
): Promise<Record<string, unknown> | undefined> {
  try {
    return (await api.get(
      `${path}/slug/${assertPathSegment(slug, 'organizer slug')}`
    )) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MealieApiError && SLUG_ROUTE_MISS.has(error.status)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Turns organizer *names* into the full records a recipe write needs.
 *
 * Mealie's recipe routes do not accept `{name: "Dessert"}` for a tag or
 * category, even though that is what the field looks like on the way out: the
 * request model requires `slug` as well, and answers HTTP 422
 * (`loc: ["body","tags",0,"slug"]`) without it. So every name is looked up
 * first, and anything unknown is created — which is also what makes
 * "tag it as X" work when X does not exist yet.
 *
 * Matching is exact but case-insensitive. A fuzzy match would be worse than no
 * match: silently filing a recipe under a similarly-named tag is not something
 * the caller can see.
 */
export async function resolveOrganizers(
  api: MealieApi,
  kind: 'tag' | 'category',
  names: string[]
): Promise<Record<string, unknown>[]> {
  const path = ORGANIZER_PATHS[kind];
  const resolved: Record<string, unknown>[] = [];

  for (const name of names) {
    const wanted = name.trim().toLowerCase();
    const found = await findOrganizer(api, path, wanted);
    if (found) {
      resolved.push(found);
      continue;
    }
    try {
      resolved.push(
        (await api.post(path, { name })) as Record<string, unknown>
      );
    } catch (error) {
      // A 409 means it exists after all — Mealie's slug collision rules are not
      // the same as a case-insensitive name comparison (accents, punctuation).
      if (!(error instanceof MealieApiError) || error.status !== 409)
        throw error;
      const retry = await findOrganizer(api, path, wanted);
      if (!retry) throw error;
      resolved.push(retry);
    }
  }

  return resolved;
}

async function findOrganizer(
  api: MealieApi,
  path: string,
  wanted: string
): Promise<Record<string, unknown> | undefined> {
  const wantedLowercase = wanted.trim().toLowerCase();
  const data = await api.get(
    `${path}${query({ search: wantedLowercase, perPage: 100 })}`
  );
  const items = Array.isArray(data)
    ? data
    : (((data as Record<string, unknown>).items as unknown[]) ?? []);
  return items.find((item) => {
    const record = item as Record<string, unknown>;
    // Slug as well as name: the search is over names, but a caller who typed a
    // slug that has no `/slug/` hit should still land on it rather than be told
    // it does not exist.
    return [record.name, record.slug].some(
      (candidate) =>
        typeof candidate === 'string' &&
        candidate.trim().toLowerCase() === wantedLowercase
    );
  }) as Record<string, unknown> | undefined;
}

/**
 * The UUID of the user the API token belongs to, fetched once per process.
 *
 * `POST /api/users/{id}/ratings/{slug}` is the only way to rate a recipe and it
 * wants that id in the path, even though the token already identifies the user.
 */
export class CurrentUser {
  private cached: Promise<string> | undefined;

  constructor(private readonly api: MealieApi) {}

  id(): Promise<string> {
    // The promise itself is cached, so concurrent callers share one request and
    // a failed lookup is not memoised.
    this.cached ??= this.fetch().catch((error: unknown) => {
      this.cached = undefined;
      throw error;
    });
    return this.cached;
  }

  private async fetch(): Promise<string> {
    const data = await this.api.get('/api/users/self');
    const record =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)
        : {};
    const id = typeof record.id === 'string' ? record.id : undefined;
    if (id === undefined) {
      throw new ToolInputError(
        'Could not determine the current user from /api/users/self.'
      );
    }
    return id;
  }
}
