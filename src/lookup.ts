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
} as const;

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
  wantedLowercase: string
): Promise<Record<string, unknown> | undefined> {
  const data = await api.get(
    `${path}${query({ search: wantedLowercase, perPage: 100 })}`
  );
  const items = Array.isArray(data)
    ? data
    : (((data as Record<string, unknown>).items as unknown[]) ?? []);
  return items.find((item) => {
    const name = (item as Record<string, unknown>).name;
    return (
      typeof name === 'string' && name.trim().toLowerCase() === wantedLowercase
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
