import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { marked, plain } from '../output-schema.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  httpUrl,
  orderDirectionParam,
  pageParam,
  perPageParam,
  recipeRefParam,
  uuidParam,
} from '../schema.js';
import {
  commentSummary,
  listFrom,
  paginationOf,
  recipeDetail,
  recipeSummary,
  suggestion,
  timelineEvent,
} from '../shape.js';

import { assertPathSegment, query, type MealieApi } from '../api.js';
import { DESTRUCTIVE, READ_ONLY, WRITE } from './annotations.js';
import type { Config } from '../config.js';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import {
  resolveOrganizerIds,
  resolveOrganizers,
  resolveRecipe,
} from '../lookup.js';
import { contentFingerprint, presentFields } from '../fingerprint.js';
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
 * The editable recipe fields, shared by `create_recipe` and `update_recipe`.
 *
 * `name` is not in here: it is required when creating and optional when
 * updating, so each tool adds its own.
 */
const recipeFields = {
  description: z.string().max(20_000).optional(),
  ingredients: z
    .array(z.string().trim().min(1).max(1000))
    .max(200)
    .optional()
    .describe(
      'Ingredient lines as free text, e.g. "500 g quark". They replace the ' +
        'existing list. Use parse_ingredients first if structured food and ' +
        'unit references are wanted.'
    ),
  instructions: z
    .array(z.string().trim().min(1).max(20_000))
    .max(100)
    .optional()
    .describe('Preparation steps, in order. They replace the existing list.'),
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
        // else has to follow as a PATCH. The organizer lookups happen first, so
        // an unresolvable tag fails before a half-filled recipe exists.
        const patch = await buildRecipePatch(api, fields);
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
            `The recipe "${slug}" was created, but filling in its fields failed: ${reason}\n` +
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
              what: `replace ${Object.keys(replacing).sort().join(', ')} on the recipe with id ${id}`,
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

        const patch = await buildRecipePatch(api, fields);
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
    'set_recipe_last_made',
    {
      title: 'Set last made',
      description:
        'Records when a recipe was last cooked. Mealie shows this on the recipe ' +
        'and sorts by it.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        timestamp: z
          .string()
          .trim()
          .regex(
            /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/,
            'must be an ISO 8601 date or date-time'
          )
          .describe(
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
 * Translates the flat tool arguments into Mealie's recipe fields.
 *
 * Exported for the tests: the mapping of free-text ingredient lines onto
 * `{note, display}` and of steps onto `{text}` is the part most likely to break
 * silently, because Mealie accepts a wrong shape and stores an empty recipe.
 */
export function recipePatch(fields: {
  name?: string | undefined;
  description?: string | undefined;
  ingredients?: string[] | undefined;
  instructions?: string[] | undefined;
  tags?: string[] | undefined;
  categories?: string[] | undefined;
  prep_time?: string | undefined;
  cook_time?: string | undefined;
  total_time?: string | undefined;
  servings?: number | undefined;
  recipe_yield?: string | undefined;
  notes?: { title: string; text: string }[] | undefined;
  source_url?: string | undefined;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.ingredients !== undefined) {
    // An unparsed ingredient carries the whole line in `note`; `display` is what
    // Mealie renders and stays in sync with it.
    patch.recipeIngredient = fields.ingredients.map((line) => ({
      note: line,
      display: line,
      quantity: 0,
    }));
  }
  if (fields.instructions !== undefined) {
    patch.recipeInstructions = fields.instructions.map((text) => ({
      title: '',
      text,
    }));
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
 * {@link recipePatch} plus the organizer lookups it cannot do on its own.
 *
 * Kept separate so the pure field mapping stays testable without a server, and
 * so the two round trips only happen when tags or categories were actually
 * given.
 */
async function buildRecipePatch(
  api: MealieApi,
  fields: Parameters<typeof recipePatch>[0]
): Promise<Record<string, unknown>> {
  const patch = recipePatch(fields);
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
