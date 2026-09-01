import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import { query, type MealieApi } from '../api.js';
import type { Config } from '../config.js';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import { resolveRecipe } from '../lookup.js';
import { errorResult, run, textResult, untrustedResult } from '../result.js';
import { confirmTokenParam, recipeRefParam, uuidParam } from '../schema.js';
import { listFrom, shareToken, shareUrl } from '../shape.js';

export function registerSharingReadTools(
  server: McpServer,
  api: MealieApi,
  config: Config
): void {
  server.registerTool(
    'list_share_tokens',
    {
      title: 'List recipe share links',
      description:
        'Lists the public share links that currently exist, with the recipe each ' +
        'one exposes and when it expires. Anyone holding such a link can read the ' +
        'recipe without an account.',
      inputSchema: z.object({
        recipe: recipeRefParam
          .optional()
          .describe('Restrict the result to one recipe'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ recipe }) =>
      run(async () => {
        const recipeId =
          recipe === undefined
            ? undefined
            : (await resolveRecipe(api, recipe)).id;
        const data = await api.get(
          `/api/shared/recipes${query({ recipe_id: recipeId })}`
        );
        const tokens = listFrom(data).map((token) => {
          const shaped = shareToken(token);
          return {
            ...shaped,
            url: shareUrl(config.url, shaped.id as string | undefined),
          };
        });
        return untrustedResult({ numTokens: tokens.length, tokens });
      })
  );
}

export function registerSharingWriteTools(
  server: McpServer,
  api: MealieApi,
  config: Config,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_share_token',
    {
      title: 'Create a public share link',
      description:
        'Creates a link that lets anyone read one recipe without logging in. ' +
        'Requires confirmation: call once to receive a token, then again with ' +
        'that token.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        expires_at: z
          .string()
          .trim()
          .regex(
            /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/,
            'must be an ISO 8601 date or date-time'
          )
          .optional()
          .describe(
            'When the link stops working. Omitted, it never expires — prefer ' +
              'setting a date.'
          ),
        confirm_token: confirmTokenParam,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ recipe, expires_at, confirm_token }, mcp) =>
      run(async () => {
        const { id } = await resolveRecipe(api, recipe);
        // Guarded like a destructive operation even though it destroys nothing:
        // this is the one tool that widens who can see the data, and unlike a
        // deletion the effect is invisible until someone uses the link.
        const key = `create_share_token:${id}:${expires_at ?? 'never'}`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `create a public link to the recipe with id ${id}, readable by anyone who has it, ${
              expires_at === undefined
                ? 'with no expiry date'
                : `expiring ${expires_at}`
            }`,
            consequence:
              'This makes the recipe readable outside the instance until the link is deleted.',
            resourceKey: key,
            token: confirm_token,
            toolName: 'create_share_token',
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
            `The user declined. create_share_token did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;
        const data = await api.post('/api/shared/recipes', {
          recipeId: id,
          ...(expires_at === undefined ? {} : { expiresAt: expires_at }),
        });
        const shaped = shareToken(data);
        return untrustedResult({
          ...shaped,
          url: shareUrl(config.url, shaped.id as string | undefined),
        });
      })
  );

  server.registerTool(
    'delete_share_token',
    {
      title: 'Revoke a public share link',
      description:
        'Revokes a share link, so the recipe is no longer readable through it. ' +
        'Needs no confirmation — this narrows access rather than widening it.',
      inputSchema: z.object({
        token_id: uuidParam.describe(
          'Share token UUID, from list_share_tokens'
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ token_id }) =>
      run(async () => {
        await api.delete(`/api/shared/recipes/${token_id}`);
        return textResult(`Revoked the share link with id ${token_id}.`);
      })
  );
}
