import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { assertPathSegment, query, type MealieApi } from '../api.js';
import { confirmationPrompt, type ConfirmationStore } from '../confirm.js';
import { run, textResult, untrustedResult } from '../result.js';
import {
  confirmTokenParam,
  pageParam,
  perPageParam,
  uuidParam,
} from '../schema.js';
import {
  cookbookSummary,
  listFrom,
  paginationOf,
  recipeSummary,
} from '../shape.js';

export function registerCookbookReadTools(
  server: McpServer,
  api: MealieApi
): void {
  server.registerTool(
    'list_cookbooks',
    {
      title: 'List cookbooks',
      description:
        'Lists the cookbooks of the household. A cookbook is a saved filter over ' +
        'the recipe collection, not a fixed set of recipes.',
      inputSchema: { page: pageParam, per_page: perPageParam(50) },
      annotations: { readOnlyHint: true },
    },
    async ({ page, per_page }) =>
      run(async () => {
        const data = await api.get(
          `/api/households/cookbooks${query({
            page,
            perPage: per_page ?? 50,
          })}`
        );
        return untrustedResult({
          ...paginationOf(data),
          cookbooks: listFrom(data).map(cookbookSummary),
        });
      })
  );

  server.registerTool(
    'get_cookbook',
    {
      title: 'Get cookbook',
      description:
        'Fetches a cookbook and the recipes it currently matches. Accepts the ' +
        'slug or the UUID.',
      inputSchema: {
        cookbook: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .describe('Cookbook slug or UUID, from list_cookbooks'),
        per_page: perPageParam(50),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ cookbook, per_page }) =>
      run(async () => {
        const ref = assertPathSegment(cookbook, 'cookbook');
        const book = await api.get(`/api/households/cookbooks/${ref}`);
        // The cookbook record carries its filter, not its contents; the recipes
        // come from the recipe endpoint with the cookbook applied as a filter.
        const recipes = await api.get(
          `/api/recipes${query({ cookbook: ref, perPage: per_page ?? 50 })}`
        );
        return untrustedResult({
          ...cookbookSummary(book),
          ...paginationOf(recipes),
          recipes: listFrom(recipes).map(recipeSummary),
        });
      })
  );
}

export function registerCookbookWriteTools(
  server: McpServer,
  api: MealieApi,
  confirmations: ConfirmationStore
): void {
  server.registerTool(
    'create_cookbook',
    {
      title: 'Create cookbook',
      description:
        'Creates a cookbook — a named, saved view of the recipe collection. ' +
        'Without a filter it matches every recipe; the filter itself is written ' +
        "in Mealie's own query language and is easiest to build in the web UI.",
      inputSchema: {
        name: z.string().trim().min(1).max(255),
        description: z.string().max(2000).optional(),
        query_filter: z
          .string()
          .trim()
          .max(1000)
          .optional()
          .describe(
            'Mealie query filter, e.g. tags.name IN ["Dessert"]. Passed through ' +
              'verbatim; an invalid expression is rejected by Mealie with a 422.'
          ),
        is_public: z
          .boolean()
          .optional()
          .describe(
            'Make the cookbook readable without a login, default false'
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, description, query_filter, is_public }) =>
      run(async () => {
        const data = await api.post('/api/households/cookbooks', {
          name,
          description: description ?? '',
          public: is_public ?? false,
          ...(query_filter === undefined
            ? {}
            : { queryFilterString: query_filter }),
        });
        return untrustedResult(cookbookSummary(data));
      })
  );

  server.registerTool(
    'delete_cookbook',
    {
      title: 'Delete cookbook',
      description:
        'Deletes a cookbook. The recipes it matched are not touched — a cookbook ' +
        'is only a saved filter. Requires confirmation: call once to receive a ' +
        'token, then again with that token.',
      inputSchema: {
        cookbook_id: uuidParam.describe('Cookbook UUID, from list_cookbooks'),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ cookbook_id, confirm_token }) =>
      run(async () => {
        const key = `delete_cookbook:${cookbook_id}`;
        if (!confirmations.consume(key, confirm_token)) {
          return textResult(
            confirmationPrompt(
              `delete the cookbook with id ${cookbook_id}`,
              confirmations.issue(key),
              confirmations.ttlMinutes,
              'The recipes it matched are kept; only the saved view is deleted.'
            )
          );
        }
        await api.delete(`/api/households/cookbooks/${cookbook_id}`);
        return textResult(`Deleted the cookbook with id ${cookbook_id}.`);
      })
  );
}
