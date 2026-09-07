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

import { cleanText, redactUrl } from './text.js';

/** A single oversized field must not be able to consume the whole budget. */
const NAME_MAX = 300;
const DESCRIPTION_MAX = 4000;
const SUMMARY_DESCRIPTION_MAX = 400;
const TEXT_MAX = 8000;
/** Short labels — a unit, a food, a username, an event type. */
const SHORT_MAX = 200;
/** Identifiers, dates and URLs: bounded, never cleaned, because they round-trip. */
const IDENT_MAX = 512;

export function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A value the caller has to hand back — an id, a slug, a date — is validated
 * rather than cleaned: a slug with a control character in it is not a slug
 * that can be addressed, so it is dropped, not repaired. What comes out is
 * shaped like an identifier and short enough to stay one.
 */
const IDENT_SHAPE = /^[A-Za-z0-9._:+@/-]+$/;

function ident(value: unknown): string | undefined {
  const text = str(value);
  return text !== undefined &&
    text.length <= IDENT_MAX &&
    IDENT_SHAPE.test(text)
    ? text
    : undefined;
}

/** A UUID, as everything but a recipe slug is addressed by one. */
const UUID_SHAPE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function uuid(value: unknown): string | undefined {
  const text = str(value);
  return text !== undefined && UUID_SHAPE.test(text) ? text : undefined;
}

/**
 * A URL the instance stored — `orgURL` is whatever page a recipe was imported
 * from. Bounded, cleaned like text, and with any credentials in it redacted:
 * `https://user:pass@host/recipe` is a valid source URL and the model does not
 * need the password in it.
 */
function url(value: unknown): string | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  return redactUrl(cleanText(text, 2048));
}

function num(value: unknown): number | undefined {
  // `+ 0` folds -0 into 0: JSON writes -0 as `0`, and the text block and the
  // structured half of one answer have to say the same number.
  return typeof value === 'number' && Number.isFinite(value)
    ? value + 0
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

/**
 * Cleans and truncates a string field, saying so in the value itself.
 *
 * Every text the instance wrote goes through here: recipes are scraped from
 * arbitrary websites, so a name or a step can carry an escape sequence or a
 * direction override as easily as a word.
 */
export function cap(value: unknown, max: number): string | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  return cleanText(text, max);
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
  // Both halves are the instance's and both land in a URL the model may
  // follow: the id has to be a UUID and the version a short number, or there
  // is no image URL to build.
  const id = uuid(recipe.id);
  const version = imageVersion(recipe.image);
  if (!baseUrl || id === undefined || version === undefined) return undefined;
  return `${baseUrl}/api/media/recipes/${id}/images/original.webp?version=${version}`;
}

function imageVersion(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === 'string' && /^[0-9]{1,12}$/.test(value)
    ? value
    : undefined;
}

/** `{id, name, slug}` of a category, tag or tool reference on a recipe. */
function namedRef(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: ident(object.id),
    name: cap(object.name, NAME_MAX),
    slug: ident(object.slug),
  });
}

function namedRefs(value: unknown): Record<string, unknown>[] {
  return arr(value).map(namedRef);
}

/**
 * The names out of a list of references, without the holes. A reference
 * without a name used to leave `undefined` in the array, which the text block
 * wrote as `null` and the structured half did not — one answer, two stories.
 */
function names(value: unknown): string[] {
  return namedRefs(value)
    .map((ref) => ref.name)
    .filter((name): name is string => typeof name === 'string');
}

/** Times are free-text strings in Mealie ("10", "1 hour"), not durations. */
function times(recipe: Record<string, unknown>): Record<string, unknown> {
  return defined({
    totalTime: cap(recipe.totalTime, SHORT_MAX),
    prepTime: cap(recipe.prepTime, SHORT_MAX),
    cookTime: cap(recipe.cookTime, SHORT_MAX),
    performTime: cap(recipe.performTime, SHORT_MAX),
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
    unit: cap(unit.name, SHORT_MAX),
    food: cap(food.name, SHORT_MAX),
    note: cap(object.note, TEXT_MAX),
    title: cap(object.title, NAME_MAX),
    referenceId: ident(object.referenceId),
  });
}

function instruction(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: ident(object.id),
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

/**
 * Nutrition with the null-valued keys removed — Mealie sends all eleven.
 *
 * The values are strings Mealie took from the page ("300 kcal"), so they are
 * bounded like any other scraped text: a 300 kB `calories` used to make the
 * whole recipe unanswerable, because nothing here was array-shaped enough for
 * the budget to shrink.
 */
function nutrition(value: unknown): Record<string, unknown> | undefined {
  const entries = Object.entries(rec(value))
    .map(([key, v]) => [
      cleanText(key, 50),
      typeof v === 'number' ? num(v) : cap(v, 100),
    ])
    .filter(([, v]) => v !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * A recipe as returned by list endpoints: enough to choose one, without the
 * ingredients and steps.
 */
export function recipeSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: ident(object.id),
    slug: ident(object.slug),
    name: cap(object.name, NAME_MAX),
    description: cap(object.description, SUMMARY_DESCRIPTION_MAX),
    rating: num(object.rating),
    ...times(object),
    recipeServings: num(object.recipeServings),
    tags: names(object.tags),
    categories: names(object.recipeCategory),
    lastMade: ident(object.lastMade),
    dateAdded: ident(object.dateAdded),
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
    id: ident(object.id),
    slug: ident(object.slug),
    name: cap(object.name, NAME_MAX),
    description: cap(object.description, DESCRIPTION_MAX),
    imageUrl: imageUrl(baseUrl, object),
    rating: num(object.rating),
    ...times(object),
    recipeServings: num(object.recipeServings),
    recipeYield: cap(object.recipeYield, SHORT_MAX),
    recipeYieldQuantity: num(object.recipeYieldQuantity),
    categories: namedRefs(object.recipeCategory),
    tags: namedRefs(object.tags),
    tools: namedRefs(object.tools),
    recipeIngredient: arr(object.recipeIngredient).map(ingredient),
    recipeInstructions: arr(object.recipeInstructions).map(instruction),
    notes: arr(object.notes).map(note),
    nutrition: nutrition(object.nutrition),
    orgURL: url(object.orgURL),
    lastMade: ident(object.lastMade),
    dateAdded: ident(object.dateAdded),
    dateUpdated: ident(object.dateUpdated),
    // Surfaced because it is the one setting with a visibility consequence: a
    // public recipe is readable through the group's explore routes without a login.
    isPublic: bool(settings.public),
  });
}

export function organizerSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: ident(object.id),
    name: cap(object.name, NAME_MAX),
    slug: ident(object.slug),
    // Tools carry this, tags and categories do not.
    onHand: bool(object.onHand),
  });
}

export function foodSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  const label = rec(object.label);
  return defined({
    id: ident(object.id),
    name: cap(object.name, NAME_MAX),
    pluralName: cap(object.pluralName, NAME_MAX),
    description: cap(object.description, SUMMARY_DESCRIPTION_MAX),
    label: cap(label.name, SHORT_MAX),
    aliases: arr(object.aliases)
      .map((a) => cap(rec(a).name, NAME_MAX))
      .filter((name): name is string => name !== undefined),
  });
}

export function unitSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: ident(object.id),
    name: cap(object.name, NAME_MAX),
    pluralName: cap(object.pluralName, NAME_MAX),
    abbreviation: cap(object.abbreviation, SHORT_MAX),
    useAbbreviation: bool(object.useAbbreviation),
    fraction: bool(object.fraction),
    description: cap(object.description, SUMMARY_DESCRIPTION_MAX),
  });
}

export function mealplanEntry(value: unknown): Record<string, unknown> {
  const object = rec(value);
  const recipe = rec(object.recipe);
  return defined({
    id: num(object.id) ?? ident(object.id),
    date: ident(object.date),
    entryType: cap(object.entryType, SHORT_MAX),
    // A plan entry is either a recipe reference or a free-text note, never both.
    title: cap(object.title, NAME_MAX),
    text: cap(object.text, DESCRIPTION_MAX),
    recipeId: ident(object.recipeId),
    recipeSlug: ident(recipe.slug),
    recipeName: cap(recipe.name, NAME_MAX),
  });
}

export function shoppingListSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: ident(object.id),
    name: cap(object.name, NAME_MAX),
    // Present on the detail response only.
    itemCount: Array.isArray(object.listItems)
      ? object.listItems.length
      : undefined,
    recipeReferences: arr(object.recipeReferences).map((r) => {
      const ref = rec(r);
      return defined({
        recipeId: ident(ref.recipeId),
        quantity: num(ref.recipeQuantity),
      });
    }),
    updatedAt: ident(object.updatedAt),
  });
}

export function shoppingListItem(value: unknown): Record<string, unknown> {
  const object = rec(value);
  const unit = rec(object.unit);
  const food = rec(object.food);
  const label = rec(object.label);
  return defined({
    id: ident(object.id),
    display: cap(object.display ?? object.note, TEXT_MAX),
    checked: bool(object.checked),
    quantity: num(object.quantity),
    unit: cap(unit.name, SHORT_MAX),
    food: cap(food.name, SHORT_MAX),
    note: cap(object.note, TEXT_MAX),
    label: cap(label.name, SHORT_MAX),
    position: num(object.position),
    isFood: bool(object.isFood),
  });
}

export function cookbookSummary(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: ident(object.id),
    name: cap(object.name, NAME_MAX),
    slug: ident(object.slug),
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
    id: ident(object.id),
    recipeId: ident(object.recipeId),
    text: cap(object.text, TEXT_MAX),
    // The username, not the whole user record with its email address.
    author: cap(user.username, SHORT_MAX),
    createdAt: ident(object.createdAt),
  });
}

export function timelineEvent(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: ident(object.id),
    recipeId: ident(object.recipeId),
    subject: cap(object.subject, NAME_MAX),
    eventType: cap(object.eventType, SHORT_MAX),
    eventMessage: cap(object.eventMessage, TEXT_MAX),
    timestamp: ident(object.timestamp),
  });
}

export function shareToken(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    id: ident(object.id),
    recipeId: ident(object.recipeId),
    expiresAt: ident(object.expiresAt),
    createdAt: ident(object.createdAt),
  });
}

/**
 * The public URL a share token resolves to. Only for a UUID-shaped token id:
 * the id is the instance's, and it lands in a URL the model may hand on.
 */
export function shareUrl(
  baseUrl: string | undefined,
  tokenId: string | undefined
): string | undefined {
  return baseUrl && tokenId !== undefined && UUID_SHAPE.test(tokenId)
    ? `${baseUrl}/shared/recipes/${tokenId}`
    : undefined;
}

export function suggestion(value: unknown): Record<string, unknown> {
  const object = rec(value);
  return defined({
    recipe: recipeSummary(object.recipe),
    missingFoods: names(object.missingFoods),
    missingTools: names(object.missingTools),
  });
}
