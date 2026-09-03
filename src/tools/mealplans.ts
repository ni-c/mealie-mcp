import { z } from 'zod';
import { marked, plain } from '../output-schema.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  dateParam,
  pageParam,
  perPageParam,
  recipeRefParam,
} from '../schema.js';

import { query, type MealieApi } from '../api.js';
import { contentFingerprint, presentFields } from '../fingerprint.js';
import { DESTRUCTIVE, READ_ONLY, WRITE } from './annotations.js';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import { resolveRecipe } from '../lookup.js';
import {
  errorResult,
  run,
  jsonResult,
  ToolInputError,
  untrustedResult,
} from '../result.js';
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
      inputSchema: z.object({
        start_date: dateParam
          .optional()
          .describe('First day to include, YYYY-MM-DD'),
        end_date: dateParam
          .optional()
          .describe('Last day to include, YYYY-MM-DD'),
        page: pageParam,
        per_page: perPageParam(50),
      }),
      annotations: READ_ONLY,
      outputSchema: marked(),
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
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      outputSchema: marked(),
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
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_mealplan_entry',
    {
      title: 'Add to the meal plan',
      description:
        'Puts a recipe or a free-text note on the meal plan for one day. Give ' +
        'either a recipe or a title, not both — Mealie stores a plan entry as one ' +
        'or the other.',
      inputSchema: z.object({
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
      }),
      annotations: WRITE,
      outputSchema: marked(),
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
      inputSchema: z.object({
        date: dateParam.describe('Day of the meal, YYYY-MM-DD'),
        entry_type: entryTypeParam,
      }),
      annotations: WRITE,
      outputSchema: marked(),
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
        'Moves an entry to another day or slot, or replaces the recipe behind ' +
        'it. Replacing the written title or note of an entry requires ' +
        'confirmation: call once to receive a token, then again with that ' +
        'token. Moving the entry or swapping the recipe does not.',
      inputSchema: z.object({
        entry_id: entryIdParam,
        date: dateParam.optional(),
        entry_type: entryTypeParam.optional(),
        recipe: recipeRefParam.optional(),
        title: z.string().trim().min(1).max(255).optional(),
        text: z.string().max(2000).optional(),
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
      outputSchema: marked(),
    },
    async (
      { entry_id, date, entry_type, recipe, title, text, confirm_token },
      mcp
    ) =>
      run(async () => {
        // A note entry carries text somebody typed and Mealie keeps no history
        // of it; a day, a slot or a recipe reference is a setting, and the
        // recipe it pointed at still exists afterwards. Only the first kind is
        // guarded — the line `annotations.ts` draws, applied per call rather
        // than per tool.
        const replacing = presentFields({ title, text }, ['title', 'text']);
        if (Object.keys(replacing).length > 0) {
          const key = `update_mealplan_entry:${entry_id}:${contentFingerprint(replacing)}`;
          const outcome = await approval.requestApproval(
            server,
            mcp,
            confirmations,
            {
              what: `replace the ${Object.keys(replacing).sort().join(' and ')} of meal plan entry ${entry_id}`,
              consequence:
                'Mealie keeps no history of a plan entry. What is written there ' +
                'now is gone once this is saved.',
              resourceKey: key,
              token: confirm_token,
              toolName: 'update_mealplan_entry',
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
              `The user declined. update_mealplan_entry did nothing.`
            );
          }
          if (outcome.decision === 'pending') return outcome.result;
        }

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
      inputSchema: z.object({
        entry_id: entryIdParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
      outputSchema: plain({
        // Echoed back from `entry_id`, which `entryIdParam` has already
        // narrowed to a positive integer.
        removed_entry_id: z.number().int(),
      }),
    },
    async ({ entry_id, confirm_token }, mcp) =>
      run(async () => {
        const key = `delete_mealplan_entry:${entry_id}`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `remove meal plan entry ${entry_id}`,
            consequence:
              'The recipe itself is kept; only the plan entry is deleted.',
            resourceKey: key,
            token: confirm_token,
            toolName: 'delete_mealplan_entry',
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
            `The user declined. delete_mealplan_entry did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;
        await api.delete(`/api/households/mealplans/${entry_id}`);
        return jsonResult({ removed_entry_id: entry_id });
      })
  );
}
