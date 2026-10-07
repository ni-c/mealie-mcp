import { assertPathSegment, query, type MealieApi } from './api.js';
import { MealieApiError } from './api.js';
import { ToolInputError } from './result.js';
import { listFrom, rec } from './shape.js';

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
 *
 * Both halves are validated, not merely typed. They are the instance's
 * strings, and they go on into a path, a query-filter literal and the
 * sentence a person is asked to approve — a `"` in the id would have broken
 * out of the filter, and none of those places would have noticed.
 */
export async function resolveRecipe(
  api: MealieApi,
  ref: string
): Promise<RecipeRef> {
  return recipeRefOf(
    await api.get(`/api/recipes/${assertPathSegment(ref, 'recipe reference')}`),
    ref
  );
}

/**
 * Both identifiers out of a recipe Mealie returned, validated the way
 * {@link resolveRecipe} describes — for a caller that needs the rest of the
 * recipe as well and has fetched it already.
 */
export function recipeRefOf(data: unknown, ref: string): RecipeRef {
  const record = rec(data);
  const id =
    typeof record.id === 'string' && UUID_SHAPE.test(record.id)
      ? record.id
      : undefined;
  const slug =
    typeof record.slug === 'string' &&
    record.slug.length <= 255 &&
    SLUG_SHAPE.test(record.slug)
      ? record.slug
      : undefined;
  if (id === undefined || slug === undefined) {
    throw new ToolInputError(
      `Mealie did not return a recognisable recipe for "${ref}".`
    );
  }
  return { id, slug };
}

/**
 * How long one tool call may spend resolving organizer names.
 *
 * `search_recipes` resolves up to sixty names and `update_recipe` up to a
 * hundred, one or two requests each, in sequence — and the fifteen-second
 * timeout bounds each request, not the call. A slow instance turned one call
 * into minutes. The budget is a wall clock checked before every request.
 */
export const LOOKUP_BUDGET_MS = 30_000;

class LookupBudget {
  private readonly startedAt = Date.now();
  constructor(
    private readonly total: number,
    private readonly what: string,
    private readonly advice = 'Pass fewer names, or use ids from ' +
      'list_organizers, which need no lookup.'
  ) {}

  /** Throws once the budget is spent, naming how far the call got. */
  check(done: number): void {
    if (Date.now() - this.startedAt < LOOKUP_BUDGET_MS) return;
    throw new ToolInputError(
      `stopped after ${done} of ${this.total} ${this.what} lookups within ` +
        `${LOOKUP_BUDGET_MS / 1000} s: Mealie is answering slowly. ${this.advice}`
    );
  }
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
  const budget = new LookupBudget(values.length, kind);

  for (const value of values) {
    const wanted = value.trim();
    if (UUID_SHAPE.test(wanted)) {
      ids.push(wanted);
      continue;
    }
    budget.check(ids.length);

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
    return rec(
      await api.get(`${path}/slug/${assertPathSegment(slug, 'organizer slug')}`)
    );
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
  const budget = new LookupBudget(names.length, kind);

  for (const name of names) {
    const wanted = name.trim().toLowerCase();
    budget.check(resolved.length);
    const found = await findOrganizer(api, path, wanted);
    if (found) {
      resolved.push(found);
      continue;
    }
    try {
      resolved.push(rec(await api.post(path, { name })));
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
  return listFrom(data).find((item) => {
    const record = rec(item);
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

/** A food or a unit the way an ingredient line has to reference it. */
export interface VocabularyRef {
  id: string;
  name: string;
}

/** Where the two ingredient vocabularies live. */
const VOCABULARY_PATHS = { food: '/api/foods', unit: '/api/units' } as const;

export type VocabularyKind = keyof typeof VOCABULARY_PATHS;

/**
 * The fields a caller's word is compared against, best match first.
 *
 * Mealie's own search is fuzzy — `search=olive oils` ranks "green olive" above
 * "olive oil" — so it only narrows the candidates, and the decision is an exact
 * comparison here. Units are matched on their abbreviations as well, because
 * "tbsp" is what a recipe says.
 */
const VOCABULARY_FIELDS: Record<VocabularyKind, readonly string[]> = {
  food: ['name', 'pluralName'],
  unit: ['name', 'pluralName', 'abbreviation', 'pluralAbbreviation'],
};

/**
 * Turns food or unit names — or UUIDs — into the `{id, name}` pair an
 * ingredient line carries.
 *
 * Nothing unknown is created, unlike {@link resolveOrganizers}. A duplicate tag
 * is a nuisance; a duplicate food splits the shopping list, the pantry and the
 * suggestions in two, and cleaning those up is what a person usually came to
 * do. And nothing unknown is passed on either, because Mealie fails in both
 * directions without saying so (measured on v3.28.0):
 *
 *   food {name: "quark"}               -> HTTP 500, ValueError
 *   food {id: <unknown UUID>, name: …} -> HTTP 200, stored as no food at all
 *
 * So a UUID is looked up as well, and every value that matches nothing is
 * collected and reported in one error — the caller can then ask once, not once
 * per line.
 *
 * Returns a map keyed by the trimmed value as given.
 */
export async function resolveVocabulary(
  api: MealieApi,
  kind: VocabularyKind,
  values: readonly string[]
): Promise<Map<string, VocabularyRef>> {
  const path = VOCABULARY_PATHS[kind];
  const distinct = [...new Set(values.map((value) => value.trim()))];
  const resolved = new Map<string, VocabularyRef>();
  const unknown: string[] = [];
  const budget = new LookupBudget(
    distinct.length,
    kind,
    'Pass fewer distinct names in one call.'
  );

  for (const value of distinct) {
    budget.check(resolved.size + unknown.length);
    const found = UUID_SHAPE.test(value)
      ? await vocabularyById(api, path, value)
      : await findVocabulary(api, kind, value);
    if (found === undefined) unknown.push(value);
    else resolved.set(value, found);
  }

  if (unknown.length > 0) {
    const shown = unknown
      .slice(0, 20)
      .map((value) => `"${value.slice(0, 100)}"`)
      .join(', ');
    const more = unknown.length > 20 ? ` and ${unknown.length - 20} more` : '';
    throw new ToolInputError(
      `No ${kind} in this Mealie matches ${shown}${more}. Nothing was written. ` +
        `Ask the user whether to create ${unknown.length === 1 ? 'it' : 'them'} ` +
        `with create_${kind} or which existing ${kind} from list_${kind}s was ` +
        'meant — unknown foods and units are not created automatically.'
    );
  }
  return resolved;
}

/** A vocabulary record as a reference, if it has the two fields one needs. */
function vocabularyRef(value: unknown): VocabularyRef | undefined {
  const record = rec(value);
  return typeof record.id === 'string' &&
    UUID_SHAPE.test(record.id) &&
    typeof record.name === 'string'
    ? { id: record.id, name: record.name }
    : undefined;
}

async function vocabularyById(
  api: MealieApi,
  path: string,
  id: string
): Promise<VocabularyRef | undefined> {
  try {
    const found = vocabularyRef(
      await api.get(`${path}/${assertPathSegment(id, 'id')}`)
    );
    // The id Mealie answered with has to be the one that was asked for: a
    // record under a different id is not a confirmation that this one exists.
    return found?.id.toLowerCase() === id.toLowerCase() ? found : undefined;
  } catch (error) {
    if (error instanceof MealieApiError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function findVocabulary(
  api: MealieApi,
  kind: VocabularyKind,
  wanted: string
): Promise<VocabularyRef | undefined> {
  const wantedLowercase = wanted.toLowerCase();
  const data = await api.get(
    `${VOCABULARY_PATHS[kind]}${query({ search: wanted, perPage: 100 })}`
  );
  const records = listFrom(data).map(rec);
  const matches = (candidate: unknown) =>
    typeof candidate === 'string' &&
    candidate.trim().toLowerCase() === wantedLowercase;
  // Field by field rather than record by record, so a food *named* "egg" wins
  // over another one that merely lists "egg" as an alias.
  for (const field of VOCABULARY_FIELDS[kind]) {
    const hit = records.find((record) => matches(record[field]));
    if (hit !== undefined) return vocabularyRef(hit);
  }
  const byAlias = records.find((record) =>
    Array.isArray(record.aliases)
      ? record.aliases.some((alias) => matches(rec(alias).name))
      : false
  );
  return byAlias === undefined ? undefined : vocabularyRef(byAlias);
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
    const record = rec(data);
    // A UUID or nothing: it goes into a path.
    const id =
      typeof record.id === 'string' && UUID_SHAPE.test(record.id)
        ? record.id
        : undefined;
    if (id === undefined) {
      throw new ToolInputError(
        'Could not determine the current user from /api/users/self.'
      );
    }
    return id;
  }
}
