import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { query, type MealieApi } from '../api.js';
import { confirmationPrompt, type ConfirmationStore } from '../confirm.js';
import { resolveRecipe } from '../lookup.js';
import { run, textResult, ToolInputError, untrustedResult } from '../result.js';
import {
  confirmTokenParam,
  dateParam,
  pageParam,
  perPageParam,
  recipeRefParam,
} from '../schema.js';
import { listFrom, mealplanEntry, paginationOf } from '../shape.js';

const ENTRY_TYPES = [
  'breakfast',
  'lunch',
  'dinner',
  'side',
  'snack',
  'drink',
  'dessert',
] as const;

const entryTypeParam = z
  .enum(ENTRY_TYPES)
  .describe('Which meal of the day this entry belongs to');

/** Mealie's plan entry ids are integers, unlike everything else. */
const entryIdParam = z
  .number()
  .int()
  .positive()
  .describe('Plan entry id from list_mealplans — an integer, not a UUID');

export function registerMealplanReadTools(
  server: McpServer,
  api: MealieApi
): void {
  server.registerTool(
    'list_mealplans',
    {
      title: 'List meal plan entries',
      description:
        'Lists the meal plan of the household in a date range. Each entry is ' +
        'either a recipe reference or a free-text note.',
      inputSchema: {
        start_date: dateParam
          .optional()
          .describe('First day to include, YYYY-MM-DD'),
        end_date: dateParam
          .optional()
          .describe('Last day to include, YYYY-MM-DD'),
        page: pageParam,
        per_page: perPageParam(50),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ start_date, end_date, page, per_page }) =>
      run(async () => {
        if (
          start_date !== undefined &&
          end_date !== undefined &&
          start_date > end_date
        ) {
          throw new ToolInputError(
            'start_date must not be later than end_date.'
          );
        }
        const data = await api.get(
          `/api/households/mealplans${query({
            start_date,
            end_date,
            page,
            perPage: per_page ?? 50,
            orderBy: 'date',
            orderDirection: 'asc',
          })}`
        );
        return untrustedResult({
          ...paginationOf(data),
          entries: listFrom(data).map(mealplanEntry),
        });
      })
  );

  server.registerTool(
    'get_todays_meals',
    {
      title: "Get today's meals",
      description:
        'Returns the recipes planned for today, as Mealie computes "today" for ' +
        'the household. Answers with a bare list, not a paginated envelope.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const data = await api.get('/api/households/mealplans/today');
        const items = listFrom(data);
        return untrustedResult({
          numMeals: items.length,
          meals: items.map(mealplanEntry),
        });
      })
  );
}

export function registerMealplanWriteTools(
  server: McpServer,
  api: MealieApi,
  confirmations: ConfirmationStore
): void {
  server.registerTool(
    'create_mealplan_entry',
    {
      title: 'Add to the meal plan',
      description:
        'Puts a recipe or a free-text note on the meal plan for one day. Give ' +
        'either a recipe or a title, not both — Mealie stores a plan entry as one ' +
        'or the other.',
      inputSchema: {
        date: dateParam.describe('Day of the meal, YYYY-MM-DD'),
        entry_type: entryTypeParam,
        recipe: recipeRefParam
          .optional()
          .describe('Recipe slug or UUID to plan'),
        title: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe('Free-text entry, for a meal that is not a stored recipe'),
        text: z
          .string()
          .max(2000)
          .optional()
          .describe('Additional note shown under the title'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ date, entry_type, recipe, title, text }) =>
      run(async () => {
        if ((recipe === undefined) === (title === undefined)) {
          throw new ToolInputError(
            'Give exactly one of recipe or title: a plan entry is either a recipe reference or a free-text note.'
          );
        }
        const recipeId =
          recipe === undefined
            ? undefined
            : (await resolveRecipe(api, recipe)).id;
        const data = await api.post('/api/households/mealplans', {
          date,
          entryType: entry_type,
          title: title ?? '',
          text: text ?? '',
          ...(recipeId === undefined ? {} : { recipeId }),
        });
        return untrustedResult(mealplanEntry(data));
      })
  );

  server.registerTool(
    'create_random_meal',
    {
      title: 'Add a random meal',
      description:
        'Lets Mealie pick a recipe for a day and slot, honouring the meal plan ' +
        'rules configured in the household.',
      inputSchema: {
        date: dateParam.describe('Day of the meal, YYYY-MM-DD'),
        entry_type: entryTypeParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ date, entry_type }) =>
      run(async () => {
        const data = await api.post('/api/households/mealplans/random', {
          date,
          entryType: entry_type,
        });
        return untrustedResult(mealplanEntry(data));
      })
  );

  server.registerTool(
    'update_mealplan_entry',
    {
      title: 'Change a meal plan entry',
      description:
        'Moves an entry to another day or slot, or replaces the recipe behind it.',
      inputSchema: {
        entry_id: entryIdParam,
        date: dateParam.optional(),
        entry_type: entryTypeParam.optional(),
        recipe: recipeRefParam.optional(),
        title: z.string().trim().min(1).max(255).optional(),
        text: z.string().max(2000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ entry_id, date, entry_type, recipe, title, text }) =>
      run(async () => {
        // Mealie's plan-entry route is a PUT over the whole entry, so the current
        // state is read first and the changes are merged onto it. Sending only the
        // changed fields would blank the rest.
        const current = (await api.get(
          `/api/households/mealplans/${entry_id}`
        )) as Record<string, unknown>;
        const recipeId =
          recipe === undefined
            ? undefined
            : (await resolveRecipe(api, recipe)).id;
        const data = await api.put(`/api/households/mealplans/${entry_id}`, {
          ...current,
          ...(date === undefined ? {} : { date }),
          ...(entry_type === undefined ? {} : { entryType: entry_type }),
          ...(title === undefined ? {} : { title }),
          ...(text === undefined ? {} : { text }),
          ...(recipeId === undefined ? {} : { recipeId }),
        });
        return untrustedResult(mealplanEntry(data));
      })
  );

  server.registerTool(
    'delete_mealplan_entry',
    {
      title: 'Remove a meal plan entry',
      description:
        'Removes one entry from the meal plan. The recipe itself is not touched. ' +
        'Requires confirmation: call once to receive a token, then again with ' +
        'that token.',
      inputSchema: {
        entry_id: entryIdParam,
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ entry_id, confirm_token }) =>
      run(async () => {
        const key = `delete_mealplan_entry:${entry_id}`;
        if (!confirmations.consume(key, confirm_token)) {
          return textResult(
            confirmationPrompt(
              `remove meal plan entry ${entry_id}`,
              confirmations.issue(key),
              confirmations.ttlMinutes,
              'The recipe itself is kept; only the plan entry is deleted.'
            )
          );
        }
        await api.delete(`/api/households/mealplans/${entry_id}`);
        return textResult(`Removed meal plan entry ${entry_id}.`);
      })
  );
}
