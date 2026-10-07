import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { marked, plain } from '../output-schema.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  httpUrl,
  isoTimestampParam,
  orderDirectionParam,
  pageParam,
  perPageParam,
  recipeRefParam,
  uuidParam,
} from '../schema.js';
import {
  commentSummary,
  imageVersion,
  listFrom,
  paginationOf,
  rec,
  recipeDetail,
  recipeSummary,
  suggestion,
  timelineEvent,
} from '../shape.js';

import {
  assertPathSegment,
  LONG_TIMEOUT_MS,
  query,
  type MealieApi,
} from '../api.js';
import { DESTRUCTIVE, READ_ONLY, WRITE } from './annotations.js';
import type { Config } from '../config.js';
import {
  decodeBase64,
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BASE64_CHARS,
} from '../media.js';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import {
  recipeRefOf,
  resolveOrganizerIds,
  resolveOrganizers,
  resolveRecipe,
  resolveVocabulary,
  type VocabularyRef,
} from '../lookup.js';
import { planParse, unparsedText, type LineOverride } from '../ingredients.js';
import { contentFingerprint, presentFields } from '../fingerprint.js';
import { cleanText } from '../text.js';
import {
  errorResult,
  run,
  jsonResult,
  ToolInputError,
  untrustedResult,
} from '../result.js';

const organizerListParam = (what: string) =>
  z
    .array(z.string().trim().min(1).max(255))
    .min(1)
    .max(20)
    .optional()
    .describe(
      `Restrict the result to recipes carrying these ${what} — names, slugs or ` +
        'UUIDs. Each entry is resolved to an id before the search runs, and an ' +
        'entry that matches nothing is an error: Mealie itself would drop the ' +
        'whole filter and answer with the unfiltered collection.'
    );

/**
 * The filters Mealie resolves through its organizer tables.
 *
 * `foods` is deliberately not one of them. Mealie does not resolve foods at
 * all — `_build_recipe_filter` puts the value straight into
 * `RecipeIngredientModel.food_id == food`, so a non-UUID reaches the `GUID`
 * type decorator and comes back as HTTP 500. Confirmed on v3.22.0:
 * `GET /api/recipes?foods=carrot` is a 500. `suggest_recipes` has always taken
 * UUIDs only, and this tool now matches it.
 */
const ORGANIZER_FILTERS = ['tags', 'categories', 'tools'] as const;

export function registerRecipeReadTools(
  server: McpServer,
  api: MealieApi,
  config: Config
): void {
  server.registerTool(
    'search_recipes',
    {
      title: 'Search recipes',
      description:
        'Searches the recipe collection. Returns summaries — name, slug, id, ' +
        'times, rating, tags and categories — without ingredients or steps; use ' +
        'get_recipe for those. search, the organizer filters and the date range ' +
        'combine with AND; within one filter the entries are OR unless the ' +
        'matching require_all_* flag is set. cookbook is the exception: Mealie ' +
        'applies a cookbook instead of the tag, category, tool and food filters, ' +
        'so combining them is rejected here rather than silently ignored.',
      inputSchema: z.object({
        search: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Full-text search over names, descriptions and ingredients'
          ),
        tags: organizerListParam('tags'),
        categories: organizerListParam('categories'),
        tools: organizerListParam('tools'),
        foods: z
          .array(uuidParam)
          .min(1)
          .max(20)
          .optional()
          .describe(
            'Restrict the result to recipes using these foods, by UUID from ' +
              'list_foods. Mealie resolves no other form here and answers a name ' +
              'or a slug with HTTP 500.'
          ),
        cookbook: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe(
            'Restrict the result to a cookbook, by slug or UUID. Cannot be ' +
              'combined with the tag, category, tool or food filters.'
          ),
        require_all_tags: z
          .boolean()
          .optional()
          .describe('Require every listed tag instead of any of them'),
        require_all_categories: z.boolean().optional(),
        require_all_tools: z.boolean().optional(),
        require_all_foods: z.boolean().optional(),
        unparsed_only: z
          .boolean()
          .optional()
          .describe(
            'Only recipes with at least one ingredient line that has no food ' +
              'yet — the ones Mealie flags as not parsed. Recipes without any ' +
              'ingredients count as well. Use it to page through a collection ' +
              'with parse_recipe_ingredients.'
          ),
        order_by: z
          .enum([
            'name',
            'rating',
            'created_at',
            'updated_at',
            'last_made',
            'random',
          ])
          .optional()
          .describe(
            'Sort field, default created_at. "random" shuffles the collection; ' +
              'each call draws a new shuffle, so paging through a random order ' +
              'is not meaningful.'
          ),
        order_direction: orderDirectionParam,
        page: pageParam,
        per_page: perPageParam(25),
      }),
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async ({
      search,
      tags,
      categories,
      tools,
      foods,
      cookbook,
      require_all_tags,
      require_all_categories,
      require_all_tools,
      require_all_foods,
      unparsed_only,
      order_by,
      order_direction,
      page,
      per_page,
    }) =>
      run(async () => {
        // Mealie's `_build_recipe_filter` returns the cookbook's own filter and
        // returns early, so the organizer filters never reach the query. The
        // description above promises AND; without this the promise would be
        // broken silently, which is the failure mode this whole tool now
        // refuses to have.
        const alsoGiven = { tags, categories, tools, foods };
        const conflicting = Object.entries(alsoGiven)
          .filter(([, value]) => value !== undefined)
          .map(([name]) => name);
        if (cookbook !== undefined && conflicting.length > 0) {
          throw new ToolInputError(
            `cookbook cannot be combined with ${conflicting.join(', ')}: Mealie ` +
              'applies the cookbook filter instead of them, not on top of them, ' +
              'and says nothing about it. Either search inside the cookbook with ' +
              'get_cookbook, or drop the cookbook and filter directly.'
          );
        }

        // Names are resolved to ids here, before anything is asked of the
        // search endpoint, because Mealie drops a filter it cannot resolve and
        // answers with the whole collection instead of an error.
        const [tagIds, categoryIds, toolIds] = await Promise.all(
          ORGANIZER_FILTERS.map(async (filter) => {
            const values = alsoGiven[filter];
            return values === undefined
              ? undefined
              : resolveOrganizerIds(
                  api,
                  filter === 'categories'
                    ? 'category'
                    : filter === 'tags'
                      ? 'tag'
                      : 'tool',
                  values
                );
          })
        );

        const data = await api.get(
          `/api/recipes${query({
            search,
            tags: tagIds,
            categories: categoryIds,
            tools: toolIds,
            foods,
            cookbook,
            requireAllTags: require_all_tags,
            requireAllCategories: require_all_categories,
            requireAllTools: require_all_tools,
            requireAllFoods: require_all_foods,
            // Built here, never taken from the caller, for the reason
            // list_recipe_timeline gives. `foodId`, not `food.id`: the
            // relationship is an inner join and matches nothing that is
            // missing, the column matches every line without a food —
            // verified on v3.28.0, cookbook filter included.
            queryFilter:
              unparsed_only === true
                ? 'recipeIngredient.foodId IS NULL'
                : undefined,
            orderBy: order_by,
            // Mealie's pagination model validates this one into existence:
            // `paginationSeed is required when orderBy is random`, HTTP 422.
            // The tool takes no seed, so generating one here is the difference
            // between an option that works and an option that always fails.
            paginationSeed: order_by === 'random' ? randomUUID() : undefined,
            orderDirection: order_direction,
            page,
            perPage: per_page ?? 25,
          })}`
        );
        return untrustedResult({
          ...paginationOf(data),
          recipes: listFrom(data).map(recipeSummary),
        });
      })
  );

  server.registerTool(
    'get_recipe',
    {
      title: 'Get recipe',
      description:
        'Fetches one recipe with everything needed to cook it: ingredients, ' +
        'steps, times, yield, notes and nutrition. Accepts the slug or the UUID.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        detail: z
          .enum(['default', 'raw'])
          .optional()
          .describe(
            '"default" returns the cleaned-up recipe; "raw" returns Mealie\'s ' +
              'untouched object including settings, assets, extras and inline comments'
          ),
      }),
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async ({ recipe, detail }) =>
      run(async () => {
        const data = await api.get(
          `/api/recipes/${assertPathSegment(recipe, 'recipe')}`
        );
        return untrustedResult(
          detail === 'raw' ? data : recipeDetail(data, config.url)
        );
      })
  );

  server.registerTool(
    'suggest_recipes',
    {
      title: 'Suggest recipes',
      description:
        'Suggests recipes that can be cooked from the foods and tools marked as ' +
        '"on hand" in Mealie, ranked by how little is missing. This only produces ' +
        'anything on an instance that actually maintains structured foods, units ' +
        'and an on-hand pantry — on a collection of plain text ingredients it ' +
        'returns nothing. Use search_recipes there.',
      inputSchema: z.object({
        foods: z
          .array(uuidParam)
          .max(50)
          .optional()
          .describe('Food UUIDs to treat as available, from list_foods'),
        tools: z
          .array(uuidParam)
          .max(50)
          .optional()
          .describe('Tool UUIDs to treat as available, from list_organizers'),
        max_missing_foods: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe(
            'How many ingredients a suggestion may be missing, default 5'
          ),
        max_missing_tools: z.number().int().min(0).max(20).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Number of suggestions, default 10'),
      }),
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async ({ foods, tools, max_missing_foods, max_missing_tools, limit }) =>
      run(async () => {
        const data = await api.get(
          `/api/recipes/suggestions${query({
            foods,
            tools,
            maxMissingFoods: max_missing_foods,
            maxMissingTools: max_missing_tools,
            limit,
          })}`
        );
        const items = listFrom(data);
        return untrustedResult({
          numSuggestions: items.length,
          suggestions: items.map(suggestion),
        });
      })
  );

  server.registerTool(
    'list_recipe_comments',
    {
      title: 'List recipe comments',
      description:
        'Lists the comments other users of the instance left on a recipe.',
      inputSchema: z.object({ recipe: recipeRefParam }),
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async ({ recipe }) =>
      run(async () => {
        const { slug } = await resolveRecipe(api, recipe);
        const data = await api.get(
          `/api/recipes/${assertPathSegment(slug, 'recipe')}/comments`
        );
        const items = listFrom(data);
        return untrustedResult({
          numComments: items.length,
          comments: items.map(commentSummary),
        });
      })
  );

  server.registerTool(
    'list_recipe_timeline',
    {
      title: 'List recipe timeline',
      description:
        'Lists the timeline of a recipe: when it was created, updated and each ' +
        'time it was cooked, with the notes attached to those events.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        page: pageParam,
        per_page: perPageParam(50),
      }),
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async ({ recipe, page, per_page }) =>
      run(async () => {
        const { id } = await resolveRecipe(api, recipe);
        // The timeline endpoint has no recipe parameter — Mealie's own UI filters
        // it through the generic query DSL. The filter string is built here from
        // a resolved UUID rather than taken from the caller, so no DSL fragment
        // ever crosses the tool boundary.
        const data = await api.get(
          `/api/recipes/timeline/events${query({
            queryFilter: `recipe_id="${id}"`,
            orderBy: 'timestamp',
            orderDirection: 'desc',
            page,
            perPage: per_page ?? 50,
          })}`
        );
        return untrustedResult({
          ...paginationOf(data),
          events: listFrom(data).map(timelineEvent),
        });
      })
  );
}

/**
 * One preparation step in the object form of `instructions`.
 *
 * Mealie's `recipeInstructions` entries carry a `title` beside the `text`, and
 * a step with its own heading — "Prep", "Bake" — had no way through this
 * server while the field was a bare string. The string form stays, because it
 * is what a caller writes when the step has no heading, and it maps to the
 * same `{title: '', text}` this server always sent.
 */
const instructionStep = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  text: z.string().trim().min(1).max(20_000),
});

/** A step once zod has parsed it, as {@link recipePatch} receives it. */
type InstructionStep = z.infer<typeof instructionStep>;

/**
 * One ingredient line in the structured form of `ingredients`.
 *
 * The string form writes the whole line as a note, which is what Mealie calls
 * unparsed — the "ingredients aren't parsed yet" banner, no shopping-list
 * merge, no scaling. This form writes quantity, unit and food as references,
 * which is the only thing that clears it.
 */
const structuredIngredient = z
  .object({
    quantity: z
      .number()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe('Amount, e.g. 2 or 0.5; omit for none'),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe(
        'Unit name, plural or abbreviation ("tbsp"), or its UUID from list_units'
      ),
    food: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe('Food name or plural ("eggs"), or its UUID from list_foods'),
    note: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe('The rest of the line, e.g. "finely chopped"'),
    title: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe('A section heading that starts at this line, e.g. "Sauce"'),
    original_text: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe('The line as it was written before it was structured'),
  })
  .refine(
    (line) =>
      line.food !== undefined || (line.note !== undefined && line.note !== ''),
    { message: 'A structured ingredient needs a food or a note.' }
  );

/** A structured line once zod has parsed it. */
type StructuredIngredient = z.infer<typeof structuredIngredient>;

/** The foods and units of an ingredient list, resolved to references. */
export interface IngredientRefs {
  foods: ReadonlyMap<string, VocabularyRef>;
  units: ReadonlyMap<string, VocabularyRef>;
}

const NO_REFS: IngredientRefs = { foods: new Map(), units: new Map() };

/**
 * The editable recipe fields, shared by `create_recipe` and `update_recipe`.
 *
 * `name` is not in here: it is required when creating and optional when
 * updating, so each tool adds its own.
 */
const recipeFields = {
  description: z.string().max(20_000).optional(),
  ingredients: z
    .array(z.union([z.string().trim().min(1).max(1000), structuredIngredient]))
    .max(200)
    .optional()
    .describe(
      'Ingredient lines. They replace the existing list. Each is either free ' +
        'text ("500 g quark"), which Mealie shows as unparsed, or an object ' +
        '{quantity, unit, food, note, title, original_text} with unit and food ' +
        'given by name or UUID. Unknown foods and units are an error, not ' +
        'created: add them with create_food/create_unit first. To structure ' +
        "a recipe's existing lines in place, use parse_recipe_ingredients."
    ),
  instructions: z
    .array(z.union([z.string().trim().min(1).max(20_000), instructionStep]))
    .max(100)
    .optional()
    .describe(
      'Preparation steps, in order. They replace the existing list. Each ' +
        'step is either plain text or an object {title, text} when the step ' +
        'has its own heading (e.g. "Prep", "Bake"); a bare string is ' +
        'equivalent to {text} with no title.'
    ),
  tags: z
    .array(z.string().trim().min(1).max(255))
    .max(50)
    .optional()
    .describe(
      'Tag names. They replace the existing tags; unknown names are created.'
    ),
  categories: z
    .array(z.string().trim().min(1).max(255))
    .max(50)
    .optional()
    .describe('Category names. They replace the existing categories.'),
  prep_time: z.string().max(100).optional(),
  cook_time: z.string().max(100).optional(),
  total_time: z.string().max(100).optional(),
  servings: z.number().min(0).max(10_000).optional(),
  recipe_yield: z.string().max(255).optional(),
  notes: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(255),
        text: z.string().max(20_000),
      })
    )
    .max(50)
    .optional(),
  // `httpUrl`, not a bare string: this was the only URL-shaped argument in the
  // server without a scheme check, and Mealie does not validate `org_url`
  // either. Nothing fetches it — which is why the synchronous half of the guard
  // is enough here and no host lookup happens — but it is handed back to every
  // reader of the recipe by `recipeDetail`, and `javascript:` or `data:` is not
  // something this server should be willing to store and repeat.
  source_url: httpUrl
    .optional()
    .describe(
      'Original source of the recipe, an http:// or https:// address, stored as orgURL'
    ),
} as const;

/**
 * The fields of a recipe write that replace something a person wrote.
 *
 * Everything else `update_recipe` accepts is a measurement or a setting —
 * times, servings, yield, the source link. Losing "15 min" is not the same as
 * losing a page of instructions, and the line drawn in `annotations.ts` is the
 * line drawn here.
 */
const REPLACED_RECIPE_CONTENT = [
  'name',
  'description',
  'ingredients',
  'instructions',
  'tags',
  'categories',
  'notes',
] as const;

export function registerRecipeWriteTools(
  server: McpServer,
  api: MealieApi,
  config: Config,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_recipe',
    {
      title: 'Create recipe',
      description:
        'Creates a recipe from the given fields. To add one from a website use ' +
        'import_recipe_from_url instead — it fills in far more.',
      inputSchema: z.object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .describe(
            'Recipe name. Mealie derives the slug from it and rejects a duplicate.'
          ),
        ...recipeFields,
      }),
      annotations: WRITE,
      outputSchema: marked(),
    },
    async ({ name, ...fields }) =>
      run(async () => {
        // Creating is two calls, not one: POST /api/recipes accepts nothing but
        // {name} and answers with the bare slug as a JSON string, so everything
        // else has to follow as a PATCH. The lookups happen first, so an
        // unknown food or an unresolvable tag fails before a half-filled
        // recipe exists.
        const refs = await resolveIngredientRefs(api, fields.ingredients);
        const patch = await buildRecipePatch(api, fields, refs);
        const created = await api.post('/api/recipes', { name });
        const slug =
          typeof created === 'string'
            ? created
            : typeof (created as Record<string, unknown> | null)?.slug ===
                'string'
              ? ((created as Record<string, unknown>).slug as string)
              : undefined;
        if (slug === undefined) {
          throw new ToolInputError(
            'Mealie did not return a slug for the new recipe.'
          );
        }

        const path = `/api/recipes/${assertPathSegment(slug, 'recipe')}`;
        let data: unknown;
        try {
          data =
            Object.keys(patch).length > 0
              ? await api.patch(path, patch)
              : await api.get(path);
        } catch (error) {
          // The recipe itself was already created. Saying so beats leaving an
          // empty recipe behind that nobody knows about.
          const reason = error instanceof Error ? error.message : String(error);
          throw new ToolInputError(
            `The recipe "${slug.slice(0, 255)}" was created, but filling in its fields failed: ${cleanText(reason, 300)}\n` +
              'Use update_recipe to complete it, or delete_recipe to remove it.'
          );
        }
        return untrustedResult(recipeDetail(data, config.url));
      })
  );

  server.registerTool(
    'update_recipe',
    {
      title: 'Update recipe',
      description:
        'Changes individual fields of a recipe. Only the fields given are ' +
        'touched; everything else keeps its value. Passing an empty array for ' +
        'ingredients, instructions, tags or categories clears that list. ' +
        'Replacing written content — name, description, ingredients, ' +
        'instructions, tags, categories or notes — requires confirmation: call ' +
        'once to receive a token, then again with that token. Changing only ' +
        'times, servings, yield or the source link does not.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        name: z.string().trim().min(1).max(255).optional(),
        ...recipeFields,
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
      outputSchema: marked(),
    },
    async ({ recipe, confirm_token, ...fields }, mcp) =>
      run(async () => {
        // Before the question, because it only reads: an unknown food is an
        // answer the caller needs before a person is asked anything.
        const refs = await resolveIngredientRefs(api, fields.ingredients);
        // Before the patch is built, not after: buildRecipePatch creates the
        // tags and categories it cannot find, so asking afterwards would leave
        // those behind even when the person says no.
        const replacing = presentFields(fields, REPLACED_RECIPE_CONTENT);
        if (Object.keys(replacing).length > 0) {
          // Guarded for the reason `annotations.ts` gives and the guard did not
          // follow: Mealie keeps no version history, so this replaces text a
          // person wrote with nowhere to read the old version back from. It is
          // the cheaper way to empty a recipe than delete_recipe, which was
          // guarded from the start — one call against two.
          const { id } = await resolveRecipe(api, recipe);
          // The id, so a token issued for a slug cannot be replayed against a
          // recipe that has since taken that slug — and the fingerprint of the
          // replacing values, so it cannot be turned onto different content for
          // the same recipe.
          const key = `update_recipe:${id}:${contentFingerprint(replacing)}`;
          const outcome = await approval.requestApproval(
            server,
            mcp,
            confirmations,
            {
              what: `replace ${Object.keys(replacing).toSorted().join(', ')} on the recipe with id ${id}`,
              consequence:
                'Mealie keeps no version history. The current text is gone once ' +
                'this is written, and there is nowhere to read it back from.',
              resourceKey: key,
              token: confirm_token,
              toolName: 'update_recipe',
              hint: 'Tick to go ahead, leave it to cancel.',
            }
          );
          // A token that was sent and did not match is refused with the reason
          // rather than answered with a fresh prompt; the sentence is the
          // library's, so every server refuses in the same words.
          if (outcome.decision === 'rejected') {
            return errorResult(outcome.reason);
          }
          if (outcome.decision === 'declined') {
            return errorResult(`The user declined. update_recipe did nothing.`);
          }
          if (outcome.decision === 'pending') return outcome.result;
        }

        const patch = await buildRecipePatch(api, fields, refs);
        if (Object.keys(patch).length === 0) {
          // Not an error, and the integration suite pins that: a model that
          // resolved every field to its current value should not be punished
          // for asking. It is an answer that says nothing changed.
          return untrustedResult({
            recipe,
            changed: false,
            note: 'Nothing to update: no field was given.',
          });
        }
        // PATCH, never PUT. Mealie's PUT route replaces the whole 33-field recipe
        // object, so a partial body there silently drops ingredients, steps and
        // tags. PUT is not exposed by this server at all.
        const data = await api.patch(
          `/api/recipes/${assertPathSegment(recipe, 'recipe')}`,
          patch
        );
        return untrustedResult(recipeDetail(data, config.url));
      })
  );

  server.registerTool(
    'parse_recipe_ingredients',
    {
      title: 'Parse recipe ingredients',
      description:
        "Structures a recipe's unparsed ingredient lines in place: Mealie's " +
        'parser splits each line into quantity, unit, food and note, and the ' +
        'lines whose food and unit exist in Mealie and whose confidence is high ' +
        'enough are written back. Lines that already have a food are left ' +
        'alone. Everything else comes back under needs_decision with the ' +
        'reason — ask the user there, then create the food with create_food ' +
        'and run this again, or pass the existing food they chose in ' +
        'overrides. Runs as a dry run unless dry_run is false; writing ' +
        'requires confirmation: call once to receive a token, then again with ' +
        'that token. Find recipes to work through with search_recipes ' +
        'unparsed_only.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        parser: z
          .enum(['nlp', 'brute'])
          .optional()
          .describe(
            '"nlp" (default) uses the trained model and reports a real ' +
              'confidence. "brute" is rule-based and reports 1.0 for whatever ' +
              'it splits, so min_confidence does not protect anything there. ' +
              'The "openai" parser is not offered: it sends every line to an ' +
              'external provider.'
          ),
        min_confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'Lowest average parser confidence that is written without asking, ' +
              'default 0.9. Lines below it go to needs_decision.'
          ),
        overrides: z
          .array(
            z
              .object({
                index: z
                  .number()
                  .int()
                  .min(0)
                  .max(199)
                  .describe('The line, as index in needs_decision'),
                food: z
                  .string()
                  .trim()
                  .min(1)
                  .max(255)
                  .optional()
                  .describe('Existing food name or UUID to use for the line'),
                unit: z
                  .string()
                  .trim()
                  .min(1)
                  .max(255)
                  .optional()
                  .describe('Existing unit name or UUID to use for the line'),
              })
              .refine(
                (override) =>
                  override.food !== undefined || override.unit !== undefined,
                { message: 'An override needs a food or a unit.' }
              )
          )
          .max(200)
          .optional()
          .describe(
            "The user's answers for lines from needs_decision. An override " +
              "replaces the parser's food or unit for that line and settles " +
              "its confidence; the parser's quantity and note are kept."
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'Default true: report what would be written, write nothing and ask ' +
              'nothing. Pass false to write.'
          ),
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
      outputSchema: marked(),
    },
    async (
      { recipe, parser, min_confidence, overrides, dry_run, confirm_token },
      mcp
    ) =>
      run(async () => {
        const data = await api.get(
          `/api/recipes/${assertPathSegment(recipe, 'recipe')}`
        );
        const { id, slug } = recipeRefOf(data, recipe);
        const ingredients = rec(data).recipeIngredient;
        const current = Array.isArray(ingredients) ? ingredients : [];
        const targets = current.flatMap((line: unknown, index) => {
          const text = unparsedText(line);
          return text === undefined ? [] : [{ index, line: text }];
        });
        const parserName = parser ?? 'nlp';
        const minConfidence = min_confidence ?? 0.9;
        const dryRun = dry_run ?? true;

        const overrideMap = await resolveOverrides(
          api,
          overrides ?? [],
          new Set(targets.map((target) => target.index))
        );

        if (targets.length === 0) {
          return untrustedResult({
            recipe: slug,
            id,
            dry_run: dryRun,
            lines: current.length,
            unparsed: 0,
            structured: [],
            needs_decision: [],
            written: false,
            note: 'Nothing to parse: every ingredient line already has a food, or the recipe has none.',
          });
        }

        if (!dryRun) {
          // Asked before the parser runs, and bound to what goes in rather
          // than to what comes out: the lines, the parser, the threshold and
          // the person's own choices. The same input parses the same way, so
          // a token cannot be spent on different lines, a lower threshold or
          // a different food than the ones it was issued for.
          const key =
            `parse_recipe_ingredients:${id}:` +
            contentFingerprint({
              targets,
              parser: parserName,
              min_confidence: minConfidence,
              overrides: [...overrideMap].toSorted(([a], [b]) => a - b),
            });
          const outcome = await approval.requestApproval(
            server,
            mcp,
            confirmations,
            {
              what:
                `write quantity, unit and food to the ${targets.length} ` +
                `unparsed ingredient lines of the recipe with id ${id} that ` +
                `the ${parserName} parser matches to existing foods with ` +
                `confidence ${minConfidence} or more` +
                (overrideMap.size > 0
                  ? `, and to the ${overrideMap.size} lines with a food or unit chosen by hand`
                  : ''),
              consequence:
                'Mealie keeps no version history. Each written line keeps its ' +
                'wording in originalText, but the note it shows is replaced by ' +
                'what the parser left over.',
              resourceKey: key,
              token: confirm_token,
              toolName: 'parse_recipe_ingredients',
              hint: 'Tick to go ahead, leave it to cancel.',
            }
          );
          // A token that was sent and did not match is refused with the reason
          // rather than answered with a fresh prompt; the sentence is the
          // library's, so every server refuses in the same words.
          if (outcome.decision === 'rejected') {
            return errorResult(outcome.reason);
          }
          if (outcome.decision === 'declined') {
            return errorResult(
              'The user declined. parse_recipe_ingredients did nothing.'
            );
          }
          if (outcome.decision === 'pending') return outcome.result;
        }

        // The long timeout: the trained model parses line by line inside the
        // request, and a recipe may have two hundred of them.
        const results = await api.post(
          '/api/parser/ingredients',
          { parser: parserName, ingredients: targets.map((t) => t.line) },
          LONG_TIMEOUT_MS
        );
        if (!Array.isArray(results)) {
          throw new ToolInputError(
            "Mealie's ingredient parser did not answer with a list. Nothing was written."
          );
        }
        const plan = planParse(
          current,
          targets,
          results,
          minConfidence,
          overrideMap
        );

        const write = !dryRun && plan.structured.length > 0;
        if (write) {
          // The whole list, because recipeIngredient is replaced as a whole;
          // the lines that were not touched go back exactly as they came.
          await api.patch(`/api/recipes/${assertPathSegment(slug, 'recipe')}`, {
            recipeIngredient: plan.ingredients,
          });
        }
        return untrustedResult({
          recipe: slug,
          id,
          dry_run: dryRun,
          lines: current.length,
          unparsed: targets.length,
          structured: plan.structured,
          needs_decision: plan.undecided,
          written: write,
          next: parseNextStep(
            dryRun,
            plan.structured.length,
            plan.undecided.length
          ),
        });
      })
  );

  server.registerTool(
    'duplicate_recipe',
    {
      title: 'Duplicate recipe',
      description:
        'Creates a copy of a recipe under a new name, leaving the original ' +
        'untouched. Useful as a starting point for a variation.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        name: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe('Name of the copy; Mealie appends a counter when omitted'),
      }),
      annotations: WRITE,
      outputSchema: marked(),
    },
    async ({ recipe, name }) =>
      run(async () => {
        const data = await api.post(
          `/api/recipes/${assertPathSegment(recipe, 'recipe')}/duplicate`,
          name === undefined ? {} : { name }
        );
        return untrustedResult(recipeDetail(data, config.url));
      })
  );

  server.registerTool(
    'set_recipe_image',
    {
      title: 'Set recipe image',
      description: "Replaces a recipe's cover image.",
      inputSchema: z.object({
        recipe: recipeRefParam,
        image_base64: z
          .string()
          .min(1)
          .max(MAX_IMAGE_BASE64_CHARS)
          .describe('The image, base64-encoded, without a data: URI prefix'),
        format: z
          .enum(['jpeg', 'jpg', 'png', 'webp'])
          .describe(
            'Image format, used for the upload filename, extension field and content type'
          ),
      }),
      // `WRITE`, not `DESTRUCTIVE`, and that is a decision rather than the
      // default. The rule in `annotations.ts` is about content a person wrote,
      // and a cover image usually is not: Mealie's scraper fetches it during
      // an import, and re-importing from `orgURL` brings it back. Guarding the
      // everyday call — set a picture on the recipe that just came in — is the
      // direction `approval.md` warns about, where whoever answers the dialog
      // for the harmless call stops reading it before the one that matters.
      annotations: WRITE,
      outputSchema: plain({ recipe: z.string(), image_version: z.string() }),
    },
    async ({ recipe, image_base64, format }) =>
      run(async () => {
        const bytes = decodeBase64(image_base64, 'image_base64');
        const ref = assertPathSegment(recipe, 'recipe');
        // One spelling, used three times over. Mealie's upload route wants the
        // extension without a leading dot, and `jpg` is how it is conventionally
        // written — but the filename and the content type describe the same
        // bytes, so deriving all three from one value is what keeps them from
        // disagreeing. Only `extension` is read today; the filename merely has
        // to be there, or the part arrives as a string rather than as a file.
        const extension = format === 'jpeg' ? 'jpg' : format;
        const form = new FormData();
        form.append(
          'image',
          new Blob([bytes as unknown as ArrayBuffer], {
            type: IMAGE_MIME_TYPES[extension],
          }),
          `recipe.${extension}`
        );
        form.append('extension', extension);
        // The long timeout, for the reason `LONG_TIMEOUT_MS` gives: this is the
        // largest body the server ever sends, and Mealie re-encodes it to WebP
        // in three sizes inside the request.
        const updated = await api.put(
          `/api/recipes/${ref}/image`,
          form,
          LONG_TIMEOUT_MS
        );
        // Mealie answers with the recipe's new image version — the cache-busting
        // counter that `imageUrl` is built from. Reporting that, rather than a
        // constant `true`, is the difference between saying what happened and
        // saying what was asked for: every failure here is an error result, so a
        // boolean could only ever have read `true`.
        const version = imageVersion(rec(updated).image);
        if (version === undefined) {
          throw new ToolInputError(
            `Mealie accepted the upload for "${ref}" but did not report a new image version. ` +
              'Read the recipe back to check whether the image was stored.'
          );
        }
        return jsonResult({ recipe: ref, image_version: version });
      })
  );

  server.registerTool(
    'set_recipe_last_made',
    {
      title: 'Set last made',
      description:
        'Records when a recipe was last cooked. Mealie shows this on the recipe ' +
        'and sorts by it.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        timestamp: isoTimestampParam.describe(
          'When it was made, e.g. 2026-08-18 or 2026-08-18T19:30:00Z'
        ),
      }),
      annotations: WRITE,
      outputSchema: plain({ recipe: z.string(), last_made: z.string() }),
    },
    async ({ recipe, timestamp }) =>
      run(async () => {
        await api.patch(
          `/api/recipes/${assertPathSegment(recipe, 'recipe')}/last-made`,
          { timestamp }
        );
        return jsonResult({ recipe, last_made: timestamp });
      })
  );

  server.registerTool(
    'delete_recipe',
    {
      title: 'Delete recipe',
      description:
        'Deletes a recipe permanently, together with its comments, timeline and ' +
        'images. Requires confirmation: call once to receive a token, then again ' +
        'with that token.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
      outputSchema: plain({ deleted_recipe_id: z.string() }),
    },
    async ({ recipe, confirm_token }, mcp) =>
      run(async () => {
        const { id, slug } = await resolveRecipe(api, recipe);
        // Keyed by the resolved UUID, so a token issued for a slug cannot be
        // replayed against a different recipe that has since taken that slug.
        const key = `delete_recipe:${id}`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `permanently delete the recipe with id ${id}, including its comments, timeline and images`,
            consequence:
              'Mealie has no undelete. Cookbooks, meal plans and shopping lists ' +
              'that reference the recipe lose it.',
            resourceKey: key,
            token: confirm_token,
            toolName: 'delete_recipe',
            hint: 'Tick to go ahead, leave it to cancel.',
          }
        );
        // A token that was sent and did not match is refused with the reason
        // rather than answered with a fresh prompt; the sentence is the
        // library's, so every server refuses in the same words.
        if (outcome.decision === 'rejected') {
          return errorResult(outcome.reason);
        }
        if (outcome.decision === 'declined') {
          return errorResult(`The user declined. delete_recipe did nothing.`);
        }
        if (outcome.decision === 'pending') return outcome.result;
        await api.delete(`/api/recipes/${assertPathSegment(slug, 'recipe')}`);
        return jsonResult({ deleted_recipe_id: id });
      })
  );
}

/**
 * The caller's overrides, checked against the recipe and resolved.
 *
 * An index that does not name an unparsed line is refused rather than
 * skipped: the caller meant some line, and quietly writing nothing for it
 * would read as success.
 */
async function resolveOverrides(
  api: MealieApi,
  overrides: readonly {
    index: number;
    food?: string | undefined;
    unit?: string | undefined;
  }[],
  unparsed: ReadonlySet<number>
): Promise<Map<number, LineOverride>> {
  const seen = new Set<number>();
  for (const { index } of overrides) {
    if (!unparsed.has(index)) {
      throw new ToolInputError(
        `overrides names line ${index}, which is not an unparsed ingredient ` +
          'line of this recipe. Use the index from needs_decision.'
      );
    }
    if (seen.has(index)) {
      throw new ToolInputError(
        `overrides names line ${index} twice. Give one override per line.`
      );
    }
    seen.add(index);
  }
  const refs = await resolveIngredientRefs(
    api,
    overrides.map(({ food, unit }) => ({ food, unit }))
  );
  return new Map(
    overrides.map((override) => [
      override.index,
      {
        food:
          override.food === undefined
            ? undefined
            : refFor(refs.foods, override.food),
        unit:
          override.unit === undefined
            ? undefined
            : refFor(refs.units, override.unit),
      },
    ])
  );
}

/** What the model should do after a parse run, in one sentence or two. */
function parseNextStep(
  dryRun: boolean,
  structured: number,
  undecided: number
): string {
  const parts: string[] = [];
  if (dryRun && structured > 0) {
    parts.push(
      `Nothing was written. Call again with dry_run: false to write the ${structured} structured lines.`
    );
  } else if (structured === 0) {
    parts.push('Nothing was written.');
  }
  if (undecided > 0) {
    parts.push(
      `${undecided} lines need a decision. For each, ask the user: create ` +
        'the missing food or unit with create_food or create_unit and run ' +
        'this again (the parser then finds it), or pick an existing one from ' +
        'list_foods / list_units and pass it as overrides [{index, food}]. ' +
        'Lines nobody decides stay as they are.'
    );
  }
  return parts.length > 0 ? parts.join(' ') : 'Done.';
}

/**
 * Translates the flat tool arguments into Mealie's recipe fields.
 *
 * Exported for the tests: the mapping of free-text ingredient lines onto
 * `{note, display}` and of steps onto `{text}` is the part most likely to break
 * silently, because Mealie accepts a wrong shape and stores an empty recipe.
 */
export function recipePatch(
  fields: {
    name?: string | undefined;
    description?: string | undefined;
    ingredients?: (string | StructuredIngredient)[] | undefined;
    instructions?: (string | InstructionStep)[] | undefined;
    tags?: string[] | undefined;
    categories?: string[] | undefined;
    prep_time?: string | undefined;
    cook_time?: string | undefined;
    total_time?: string | undefined;
    servings?: number | undefined;
    recipe_yield?: string | undefined;
    notes?: { title: string; text: string }[] | undefined;
    source_url?: string | undefined;
  },
  refs: IngredientRefs = NO_REFS
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.ingredients !== undefined) {
    // An unparsed ingredient carries the whole line in `note`; `display` is what
    // Mealie renders and stays in sync with it.
    patch.recipeIngredient = fields.ingredients.map((line) =>
      typeof line === 'string'
        ? { note: line, display: line, quantity: 0 }
        : structuredLine(line, refs)
    );
  }
  if (fields.instructions !== undefined) {
    patch.recipeInstructions = fields.instructions.map((step) =>
      typeof step === 'string'
        ? { title: '', text: step }
        : { title: step.title ?? '', text: step.text }
    );
  }
  // Tags and categories are deliberately absent here — they are objects that
  // must carry a slug, so they need a round trip to Mealie and are added by
  // {@link buildRecipePatch}.
  if (fields.prep_time !== undefined) patch.prepTime = fields.prep_time;
  if (fields.cook_time !== undefined) patch.cookTime = fields.cook_time;
  if (fields.total_time !== undefined) patch.totalTime = fields.total_time;
  if (fields.servings !== undefined) patch.recipeServings = fields.servings;
  if (fields.recipe_yield !== undefined)
    patch.recipeYield = fields.recipe_yield;
  if (fields.notes !== undefined) patch.notes = fields.notes;
  if (fields.source_url !== undefined) patch.orgURL = fields.source_url;
  return patch;
}

/**
 * One structured line in Mealie's shape.
 *
 * Unit and food go out as `{id, name}`: Mealie answers a food without an id
 * with HTTP 500 and stores one with an unknown id as no food at all, so both
 * come from {@link resolveIngredientRefs} and nowhere else. `display` is left
 * out — Mealie renders it from the parts.
 */
function structuredLine(
  line: StructuredIngredient,
  refs: IngredientRefs
): Record<string, unknown> {
  return {
    quantity: line.quantity ?? 0,
    unit: line.unit === undefined ? null : refFor(refs.units, line.unit),
    food: line.food === undefined ? null : refFor(refs.foods, line.food),
    note: line.note ?? '',
    ...(line.title === undefined ? {} : { title: line.title }),
    ...(line.original_text === undefined
      ? {}
      : { originalText: line.original_text }),
  };
}

function refFor(
  refs: ReadonlyMap<string, VocabularyRef>,
  value: string
): VocabularyRef {
  const ref = refs.get(value.trim());
  // A programming error rather than a caller's: resolveIngredientRefs either
  // resolves every value or throws, so a gap here means it was not called.
  if (ref === undefined) {
    throw new Error(`"${value}" was not resolved before the patch was built`);
  }
  return { id: ref.id, name: ref.name };
}

/**
 * The foods and units a structured ingredient list names, as references.
 *
 * Read-only, and done before anything is asked or written, so an unknown food
 * comes back as an error before a person is shown a dialog for a write that
 * could not happen.
 */
export async function resolveIngredientRefs(
  api: MealieApi,
  ingredients: readonly (string | StructuredIngredient)[] | undefined
): Promise<IngredientRefs> {
  const structured = (ingredients ?? []).filter(
    (line): line is StructuredIngredient => typeof line !== 'string'
  );
  const foods = structured.flatMap((line) =>
    line.food === undefined ? [] : [line.food]
  );
  const units = structured.flatMap((line) =>
    line.unit === undefined ? [] : [line.unit]
  );
  return {
    foods:
      foods.length > 0
        ? await resolveVocabulary(api, 'food', foods)
        : new Map(),
    units:
      units.length > 0
        ? await resolveVocabulary(api, 'unit', units)
        : new Map(),
  };
}

/**
 * {@link recipePatch} plus the organizer lookups it cannot do on its own.
 *
 * Kept separate so the pure field mapping stays testable without a server, and
 * so the two round trips only happen when tags or categories were actually
 * given.
 */
async function buildRecipePatch(
  api: MealieApi,
  fields: Parameters<typeof recipePatch>[0],
  refs: IngredientRefs
): Promise<Record<string, unknown>> {
  const patch = recipePatch(fields, refs);
  if (fields.tags !== undefined) {
    patch.tags = await resolveOrganizers(api, 'tag', fields.tags);
  }
  if (fields.categories !== undefined) {
    patch.recipeCategory = await resolveOrganizers(
      api,
      'category',
      fields.categories
    );
  }
  return patch;
}
