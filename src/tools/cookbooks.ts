import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
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

import { assertPathSegment, query, type MealieApi } from '../api.js';
import { DESTRUCTIVE, READ_ONLY, WRITE } from './annotations.js';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import { errorResult, run, textResult, untrustedResult } from '../result.js';

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
      inputSchema: z.object({ page: pageParam, per_page: perPageParam(50) }),
      annotations: READ_ONLY,
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
      inputSchema: z.object({
        cookbook: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .describe('Cookbook slug or UUID, from list_cookbooks'),
        per_page: perPageParam(50),
      }),
      annotations: READ_ONLY,
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
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_cookbook',
    {
      title: 'Create cookbook',
      description:
        'Creates a cookbook — a named, saved view of the recipe collection. ' +
        'Without a filter it matches every recipe; the filter itself is written ' +
        "in Mealie's own query language and is easiest to build in the web UI. " +
        'A private cookbook is created straight away; is_public requires ' +
        'confirmation, because it is a publishing step.',
      inputSchema: z.object({
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
            'Make the cookbook readable without a login, default false. ' +
              'Requires confirmation: call once to receive a token, then again ' +
              'with that token.'
          ),
        confirm_token: confirmTokenParam,
      }),
      annotations: WRITE,
    },
    async (
      { name, description, query_filter, is_public, confirm_token },
      mcp
    ) =>
      run(async () => {
        // The same reason create_share_token gives, applied to the other tool
        // that widens who can see something: this one is a publishing step, and
        // like the share link its effect is invisible until somebody uses it.
        // What it exposes is narrower — Mealie's public recipe controller also
        // wants `settings.public` on each recipe and a non-private group, so the
        // recipes themselves stay closed — but the cookbook's name, description
        // and saved filter go out, and there is no update_cookbook to take it
        // back with: an accidentally public cookbook can only be deleted.
        if (is_public === true) {
          const key = `create_cookbook:${name}:public`;
          const outcome = await approval.requestApproval(
            server,
            mcp,
            confirmations,
            {
              what: 'create a cookbook that anyone can read without logging in',
              consequence:
                'Its name, description and saved filter become readable outside ' +
                'the instance. There is no tool to make it private again — an ' +
                'unwanted public cookbook has to be deleted.',
              details: [{ label: 'Cookbook name', value: name }],
              resourceKey: key,
              token: confirm_token,
              toolName: 'create_cookbook',
              hint: 'Tick to publish it, leave it to cancel.',
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
              `The user declined. create_cookbook did nothing.`
            );
          }
          if (outcome.decision === 'pending') return outcome.result;
        }

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
      inputSchema: z.object({
        cookbook_id: uuidParam.describe('Cookbook UUID, from list_cookbooks'),
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ cookbook_id, confirm_token }, mcp) =>
      run(async () => {
        const key = `delete_cookbook:${cookbook_id}`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `delete the cookbook with id ${cookbook_id}`,
            consequence:
              'The recipes it matched are kept; only the saved view is deleted.',
            resourceKey: key,
            token: confirm_token,
            toolName: 'delete_cookbook',
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
          return errorResult(`The user declined. delete_cookbook did nothing.`);
        }
        if (outcome.decision === 'pending') return outcome.result;
        await api.delete(`/api/households/cookbooks/${cookbook_id}`);
        return textResult(`Deleted the cookbook with id ${cookbook_id}.`);
      })
  );
}
