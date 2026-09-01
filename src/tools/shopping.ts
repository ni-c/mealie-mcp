import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { setResourceKey } from 'mcp-approval';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import {
  confirmTokenParam,
  pageParam,
  perPageParam,
  recipeRefParam,
  uuidParam,
} from '../schema.js';
import {
  listFrom,
  paginationOf,
  shoppingListItem,
  shoppingListSummary,
} from '../shape.js';

import { LONG_TIMEOUT_MS, query, type MealieApi } from '../api.js';
import { resolveRecipe } from '../lookup.js';
import {
  errorResult,
  run,
  textResult,
  ToolInputError,
  untrustedResult,
} from '../result.js';

const listIdParam = uuidParam.describe(
  'Shopping list UUID, from list_shopping_lists'
);

export function registerShoppingReadTools(
  server: McpServer,
  api: MealieApi
): void {
  server.registerTool(
    'list_shopping_lists',
    {
      title: 'List shopping lists',
      description:
        'Lists the shopping lists of the household, without their items.',
      inputSchema: z.object({ page: pageParam, per_page: perPageParam(50) }),
      annotations: { readOnlyHint: true },
    },
    async ({ page, per_page }) =>
      run(async () => {
        const data = await api.get(
          `/api/households/shopping/lists${query({
            page,
            perPage: per_page ?? 50,
          })}`
        );
        return untrustedResult({
          ...paginationOf(data),
          lists: listFrom(data).map(shoppingListSummary),
        });
      })
  );

  server.registerTool(
    'get_shopping_list',
    {
      title: 'Get shopping list',
      description:
        'Fetches one shopping list with all of its items, checked and unchecked.',
      inputSchema: z.object({
        list_id: listIdParam,
        include_checked: z
          .boolean()
          .optional()
          .describe('Include items already ticked off, default true'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ list_id, include_checked }) =>
      run(async () => {
        const data = await api.get(`/api/households/shopping/lists/${list_id}`);
        const record = data as Record<string, unknown>;
        const items = listFrom(record.listItems).map(shoppingListItem);
        const visible =
          include_checked === false
            ? items.filter((item) => item.checked !== true)
            : items;
        return untrustedResult({
          ...shoppingListSummary(record),
          numItems: items.length,
          numChecked: items.filter((item) => item.checked === true).length,
          items: visible,
        });
      })
  );
}

export function registerShoppingWriteTools(
  server: McpServer,
  api: MealieApi,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_shopping_list',
    {
      title: 'Create shopping list',
      description: 'Creates an empty shopping list in the household.',
      inputSchema: z.object({ name: z.string().trim().min(1).max(255) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name }) =>
      run(async () => {
        const data = await api.post('/api/households/shopping/lists', { name });
        return untrustedResult(shoppingListSummary(data));
      })
  );

  server.registerTool(
    'delete_shopping_list',
    {
      title: 'Delete shopping list',
      description:
        'Deletes a shopping list and everything on it. Requires confirmation: ' +
        'call once to receive a token, then again with that token.',
      inputSchema: z.object({
        list_id: listIdParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ list_id, confirm_token }, mcp) =>
      run(async () => {
        const key = `delete_shopping_list:${list_id}`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `delete the shopping list with id ${list_id} and every item on it`,
            consequence:
              'The list and its items cannot be restored. Recipes and meal plans ' +
              'that fed it are untouched.',
            resourceKey: key,
            token: confirm_token,
            toolName: 'delete_shopping_list',
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
            `The user declined. delete_shopping_list did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;
        await api.delete(`/api/households/shopping/lists/${list_id}`);
        return textResult(`Deleted the shopping list with id ${list_id}.`);
      })
  );

  server.registerTool(
    'add_shopping_list_items',
    {
      title: 'Add items to a shopping list',
      description:
        'Adds items to a shopping list as free text ("2 tbsp olive oil"). Mealie ' +
        'does not split these into food and unit automatically — run ' +
        'parse_ingredients first if that matters.',
      inputSchema: z.object({
        list_id: listIdParam,
        items: z
          .array(z.string().trim().min(1).max(1000))
          .min(1)
          .max(100)
          .describe('The lines to add, one item each'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list_id, items }) =>
      run(async () => {
        const data = await api.post(
          '/api/households/shopping/items/create-bulk',
          items.map((note, position) => ({
            shoppingListId: list_id,
            note,
            display: note,
            quantity: 1,
            checked: false,
            position,
          }))
        );
        const created = listFrom(
          (data as Record<string, unknown> | null)?.createdItems ?? data
        );
        return untrustedResult({
          numCreated: created.length,
          items: created.map(shoppingListItem),
        });
      })
  );

  server.registerTool(
    'update_shopping_list_items',
    {
      title: 'Tick off or change shopping list items',
      description:
        'Changes items on a shopping list — most often ticking them off. Only ' +
        'the given fields are changed; the rest of each item is preserved.',
      inputSchema: z.object({
        list_id: listIdParam,
        item_ids: z
          .array(uuidParam)
          .min(1)
          .max(100)
          .describe('Item UUIDs from get_shopping_list'),
        checked: z
          .boolean()
          .optional()
          .describe('Tick the items off (true) or put them back (false)'),
        quantity: z
          .number()
          .min(0)
          .max(100_000)
          .optional()
          .describe('Set the quantity of every listed item'),
        note: z
          .string()
          .trim()
          .max(1000)
          .optional()
          .describe('Replace the text of every listed item'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list_id, item_ids, checked, quantity, note }) =>
      run(async () => {
        if (
          checked === undefined &&
          quantity === undefined &&
          note === undefined
        ) {
          throw new ToolInputError(
            'Nothing to change: give at least one of checked, quantity or note.'
          );
        }

        // Mealie's bulk update is a REPLACE, not a patch: every field missing from
        // the payload falls back to its schema default, so a partial body would
        // silently reset quantity to 1, clear the note and untick the item. The
        // current state is therefore read first — one request for the whole list,
        // rather than one per item — and the changes are merged onto it.
        const list = (await api.get(
          `/api/households/shopping/lists/${list_id}`
        )) as Record<string, unknown>;
        const byId = new Map(
          listFrom(list.listItems).map((item) => {
            const record = item as Record<string, unknown>;
            return [String(record.id), record];
          })
        );

        const missing = item_ids.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          throw new ToolInputError(
            `${missing.length} of the given item ids are not on this list: ${missing.join(', ')}`
          );
        }

        const payload = item_ids.map((id) => ({
          ...byId.get(id),
          shoppingListId: list_id,
          id,
          ...(checked === undefined ? {} : { checked }),
          ...(quantity === undefined ? {} : { quantity }),
          ...(note === undefined ? {} : { note, display: note }),
        }));
        const data = await api.put('/api/households/shopping/items', payload);
        const updated = listFrom(
          (data as Record<string, unknown> | null)?.updatedItems ?? data
        );
        return untrustedResult({
          numUpdated: updated.length,
          items: updated.map(shoppingListItem),
        });
      })
  );

  server.registerTool(
    'delete_shopping_list_items',
    {
      title: 'Remove shopping list items',
      description:
        'Removes items from a shopping list for good. To merely tick something ' +
        'off, use update_shopping_list_items with checked=true. Requires ' +
        'confirmation: call once to receive a token, then again with that token.',
      inputSchema: z.object({
        item_ids: z
          .array(uuidParam)
          .min(1)
          .max(100)
          .describe('Item UUIDs from get_shopping_list'),
        confirm_token: confirmTokenParam,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ item_ids, confirm_token }, mcp) =>
      run(async () => {
        // Bound to a fingerprint of the sorted id set: a confirmation for three
        // items must not be usable to delete a fourth that the model appended
        // between the two calls.
        const key = setResourceKey('delete_shopping_list_items', item_ids);
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `permanently remove ${item_ids.length} item(s) from their shopping list`,
            consequence:
              'The items are removed from the list for good. Ticking an item off ' +
              'with update_shopping_list_items keeps it and is reversible.',
            resourceKey: key,
            token: confirm_token,
            toolName: 'delete_shopping_list_items',
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
            `The user declined. delete_shopping_list_items did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;
        // The ids go in the query string; this endpoint takes no body.
        await api.delete(
          `/api/households/shopping/items${query({ ids: item_ids })}`
        );
        return textResult(`Removed ${item_ids.length} item(s).`);
      })
  );

  server.registerTool(
    'add_recipe_to_shopping_list',
    {
      title: 'Add a recipe to a shopping list',
      description:
        "Adds a recipe's ingredients to a shopping list, merging them with what " +
        'is already there. Mealie remembers the recipe on the list, so ' +
        'remove_recipe_from_shopping_list can take exactly these ingredients ' +
        'back off again.',
      inputSchema: z.object({
        list_id: listIdParam,
        recipe: recipeRefParam,
        servings_multiplier: z
          .number()
          .min(0.1)
          .max(100)
          .optional()
          .describe('Scale the ingredient quantities, default 1'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list_id, recipe, servings_multiplier }) =>
      run(async () => {
        const { id } = await resolveRecipe(api, recipe);
        // Merging every ingredient into the list takes Mealie tens of seconds
        // on a large recipe, as does taking one back out.
        const data = await api.post(
          `/api/households/shopping/lists/${list_id}/recipe/${id}`,
          { recipeIncrementQuantity: servings_multiplier ?? 1 },
          LONG_TIMEOUT_MS
        );
        return untrustedResult(shoppingListSummary(data));
      })
  );

  server.registerTool(
    'remove_recipe_from_shopping_list',
    {
      title: 'Remove a recipe from a shopping list',
      description:
        "Takes a recipe's ingredients back off a shopping list. Items that were " +
        'also needed by another recipe on the list stay, with their quantity ' +
        'reduced.',
      inputSchema: z.object({
        list_id: listIdParam,
        recipe: recipeRefParam,
        servings_multiplier: z
          .number()
          .min(0.1)
          .max(100)
          .optional()
          .describe('How much of the recipe to remove, default 1'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ list_id, recipe, servings_multiplier }) =>
      run(async () => {
        const { id } = await resolveRecipe(api, recipe);
        const data = await api.post(
          `/api/households/shopping/lists/${list_id}/recipe/${id}/delete`,
          { recipeDecrementQuantity: servings_multiplier ?? 1 },
          LONG_TIMEOUT_MS
        );
        return untrustedResult(shoppingListSummary(data));
      })
  );
}
