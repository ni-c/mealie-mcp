/**
 * Projections of Mealie objects.
 *
 * Mealie's own payloads are modest — a full recipe is a few kB — so unlike other
 * servers in this family the projections are not primarily about size. They are
 * about noise: every object carries `groupId`, `householdId`, `userId`, `extras`
 * and a pair of timestamps that mean nothing to a caller who can only ever see
 * one group anyway, and recipes additionally carry `settings`, `assets` and an
 * inline `comments` array that has its own tool.
 *
 * The field names mirror Mealie's own (camelCase) so values can be matched
 * against the API docs; only `imageUrl` is derived.
 */

/** A single oversized field must not be able to consume the whole budget. */
const NAME_MAX = 300;
const DESCRIPTION_MAX = 4000;
const SUMMARY_DESCRIPTION_MAX = 400;
const TEXT_MAX = 8000;

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Drops undefined values so a projection stays free of empty keys. */
function defined<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

/** Truncates a string field, saying so in the value itself. */
export function cap(value: unknown, max: number): string | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (truncated at ${max} characters)`;
}

/**
 * Pulls the list out of a Mealie response.
 *
 * Most list endpoints answer with the pagination envelope
 * `{items, page, per_page, total, total_pages, next, previous}`, but a handful —
 * `/api/shared/recipes`, `/api/households/mealplans/today`,
 * `/api/organizers/*\/empty` — answer with a bare array. Accepting both keeps a
 * tool from reporting an empty result when the server picks the other form.
 */
export function listFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = rec(value);
  if (Array.isArray(object.items)) return object.items;
  return [];
}

/** The pagination fields of an envelope, absent for a bare-array response. */
export function paginationOf(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return {};
  const object = rec(value);
  return defined({
    page: num(object.page),
    perPage: num(object.per_page),
    total: num(object.total),
    totalPages: num(object.total_pages),
  });
}

/**
 * Builds the URL of a recipe's main image.
 *
 * The `image` field of a recipe is not a URL — it is a cache-busting counter
 * (`"107"`), and `null` when the recipe has no image. The file itself lives
 * under the media route, keyed by the recipe's UUID rather than its slug.
 */
export function imageUrl(
  baseUrl: string | undefined,
  recipe: Record<string, unknown>
): string | undefined {
  const id = str(recipe.id);
  const version = recipe.image;
  if (!baseUrl || id === undefined || version === null || version === undefined)
    return undefined;
  return `${baseUrl}/api/media/recipes/${id}/images/original.webp?version=${String(version)}`;
}

/** `{id, name, slug}` of a category, tag or tool reference on a recipe. */
function namedRef(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: str(object.id),
    name: cap(object.name, NAME_MAX),
    slug: str(object.slug),
  });
}

function namedRefs(value: unknown): Record<string, unknown>[] {
  return arr(value).map(namedRef);
}

/** Times are free-text strings in Mealie ("10", "1 hour"), not durations. */
function times(recipe: Record<string, unknown>): Record<string, unknown> {
  return defined({
    totalTime: str(recipe.totalTime),
    prepTime: str(recipe.prepTime),
    cookTime: str(recipe.cookTime),
    performTime: str(recipe.performTime),
  });
}

function ingredient(value: unknown): Record<string, unknown> {
  const object = rec(value);
  const unit = rec(object.unit);
  const food = rec(object.food);
  return defined({
    // `display` is what Mealie renders; for an unparsed ingredient it is the
    // whole line and the structured fields are empty.
    display: cap(object.display ?? object.note, TEXT_MAX),
    quantity: num(object.quantity),
    unit: str(unit.name),
    food: str(food.name),
    note: cap(object.note, TEXT_MAX),
    title: str(object.title),
    referenceId: str(object.referenceId),
  });
}

function instruction(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: str(object.id),
    title: cap(object.title, NAME_MAX),
    text: cap(object.text, TEXT_MAX),
  });
}

function note(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    title: cap(object.title, NAME_MAX),
    text: cap(object.text, TEXT_MAX),
  });
}

/** Nutrition with the null-valued keys removed — Mealie sends all eleven. */
function nutrition(value: unknown): Record<string, unknown> | undefined {
  const entries = Object.entries(rec(value)).filter(
    ([, v]) => v !== null && v !== undefined && v !== ''
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * A recipe as returned by list endpoints: enough to choose one, without the
 * ingredients and steps.
 */
export function recipeSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: str(object.id),
    slug: str(object.slug),
    name: cap(object.name, NAME_MAX),
    description: cap(object.description, SUMMARY_DESCRIPTION_MAX),
    rating: num(object.rating),
    ...times(object),
    recipeServings: num(object.recipeServings),
    tags: namedRefs(object.tags).map((t) => t.name),
    categories: namedRefs(object.recipeCategory).map((c) => c.name),
    lastMade: str(object.lastMade),
    dateAdded: str(object.dateAdded),
  });
}

/**
 * The default shape of `get_recipe`: everything needed to actually cook the
 * thing, with the bookkeeping removed.
 *
 * Deliberately dropped: `userId`/`householdId`/`groupId` (a token only ever sees
 * one), `extras` (arbitrary key/value data written by integrations), `assets`
 * (file attachments this server does not expose), `comments` (own tool, and
 * inline they would be unbounded) and the `createdAt`/`update_at` duplicates of
 * `dateAdded`/`dateUpdated`.
 */
export function recipeDetail(
  value: unknown,
  baseUrl?: string
): Record<string, unknown> {
  const object = rec(value);
  const settings = rec(object.settings);
  return defined({
    id: str(object.id),
    slug: str(object.slug),
    name: cap(object.name, NAME_MAX),
    description: cap(object.description, DESCRIPTION_MAX),
    imageUrl: imageUrl(baseUrl, object),
    rating: num(object.rating),
    ...times(object),
    recipeServings: num(object.recipeServings),
    recipeYield: str(object.recipeYield),
    recipeYieldQuantity: num(object.recipeYieldQuantity),
    categories: namedRefs(object.recipeCategory),
    tags: namedRefs(object.tags),
    tools: namedRefs(object.tools),
    recipeIngredient: arr(object.recipeIngredient).map(ingredient),
    recipeInstructions: arr(object.recipeInstructions).map(instruction),
    notes: arr(object.notes).map(note),
    nutrition: nutrition(object.nutrition),
    orgURL: str(object.orgURL),
    lastMade: str(object.lastMade),
    dateAdded: str(object.dateAdded),
    dateUpdated: str(object.dateUpdated),
    // Surfaced because it is the one setting with a visibility consequence: a
    // public recipe is readable through the group's explore routes without a login.
    isPublic: bool(settings.public),
  });
}

export function organizerSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: str(object.id),
    name: cap(object.name, NAME_MAX),
    slug: str(object.slug),
    // Tools carry this, tags and categories do not.
    onHand: bool(object.onHand),
  });
}

export function foodSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  const label = rec(object.label);
  return defined({
    id: str(object.id),
    name: cap(object.name, NAME_MAX),
    pluralName: cap(object.pluralName, NAME_MAX),
    description: cap(object.description, SUMMARY_DESCRIPTION_MAX),
    label: str(label.name),
    aliases: arr(object.aliases).map((a) => str(rec(a).name)),
  });
}

export function unitSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: str(object.id),
    name: cap(object.name, NAME_MAX),
    pluralName: cap(object.pluralName, NAME_MAX),
    abbreviation: str(object.abbreviation),
    useAbbreviation: bool(object.useAbbreviation),
    fraction: bool(object.fraction),
    description: cap(object.description, SUMMARY_DESCRIPTION_MAX),
  });
}

export function mealplanEntry(value: unknown): Record<string, unknown> {
  const object = rec(value);
  const recipe = rec(object.recipe);
  return defined({
    id: num(object.id) ?? str(object.id),
    date: str(object.date),
    entryType: str(object.entryType),
    // A plan entry is either a recipe reference or a free-text note, never both.
    title: cap(object.title, NAME_MAX),
    text: cap(object.text, DESCRIPTION_MAX),
    recipeId: str(object.recipeId),
    recipeSlug: str(recipe.slug),
    recipeName: cap(recipe.name, NAME_MAX),
  });
}

export function shoppingListSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: str(object.id),
    name: cap(object.name, NAME_MAX),
    // Present on the detail response only.
    itemCount: Array.isArray(object.listItems)
      ? object.listItems.length
      : undefined,
    recipeReferences: arr(object.recipeReferences).map((r) => {
      const ref = rec(r);
      return defined({
        recipeId: str(ref.recipeId),
        quantity: num(ref.recipeQuantity),
      });
    }),
    updatedAt: str(object.updatedAt),
  });
}

export function shoppingListItem(value: unknown): Record<string, unknown> {
  const object = rec(value);
  const unit = rec(object.unit);
  const food = rec(object.food);
  const label = rec(object.label);
  return defined({
    id: str(object.id),
    display: cap(object.display ?? object.note, TEXT_MAX),
    checked: bool(object.checked),
    quantity: num(object.quantity),
    unit: str(unit.name),
    food: str(food.name),
    note: cap(object.note, TEXT_MAX),
    label: str(label.name),
    position: num(object.position),
    isFood: bool(object.isFood),
  });
}

export function cookbookSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: str(object.id),
    name: cap(object.name, NAME_MAX),
    slug: str(object.slug),
    description: cap(object.description, SUMMARY_DESCRIPTION_MAX),
    position: num(object.position),
    isPublic: bool(object.public),
    queryFilterString: cap(object.queryFilterString, DESCRIPTION_MAX),
  });
}

export function commentSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  const user = rec(object.user);
  return defined({
    id: str(object.id),
    recipeId: str(object.recipeId),
    text: cap(object.text, TEXT_MAX),
    // The username, not the whole user record with its email address.
    author: str(user.username),
    createdAt: str(object.createdAt),
  });
}

export function timelineEvent(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: str(object.id),
    recipeId: str(object.recipeId),
    subject: cap(object.subject, NAME_MAX),
    eventType: str(object.eventType),
    eventMessage: cap(object.eventMessage, TEXT_MAX),
    timestamp: str(object.timestamp),
  });
}

export function shareToken(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: str(object.id),
    recipeId: str(object.recipeId),
    expiresAt: str(object.expiresAt),
    createdAt: str(object.createdAt),
  });
}

/** The public URL a share token resolves to. */
export function shareUrl(
  baseUrl: string | undefined,
  tokenId: string | undefined
): string | undefined {
  return baseUrl && tokenId
    ? `${baseUrl}/shared/recipes/${tokenId}`
    : undefined;
}

export function suggestion(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    recipe: recipeSummary(object.recipe),
    missingFoods: namedRefs(object.missingFoods).map((f) => f.name),
    missingTools: namedRefs(object.missingTools).map((t) => t.name),
  });
}
