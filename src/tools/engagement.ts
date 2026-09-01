import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import { assertPathSegment, type MealieApi } from '../api.js';
import { DESTRUCTIVE, WRITE } from './annotations.js';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import { resolveRecipe, type CurrentUser } from '../lookup.js';
import {
  errorResult,
  run,
  textResult,
  ToolInputError,
  untrustedResult,
} from '../result.js';
import { confirmTokenParam, recipeRefParam, uuidParam } from '../schema.js';
import { commentSummary, timelineEvent } from '../shape.js';

export function registerEngagementWriteTools(
  server: McpServer,
  api: MealieApi,
  currentUser: CurrentUser,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'set_recipe_rating',
    {
      title: 'Rate a recipe',
      description:
        'Sets the personal rating of a recipe and/or marks it as a favourite. ' +
        'Ratings in Mealie are per user, not per recipe.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        rating: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .describe('Stars from 0 to 5; 0 clears the rating'),
        is_favorite: z.boolean().optional(),
      }),
      annotations: WRITE,
    },
    async ({ recipe, rating, is_favorite }) =>
      run(async () => {
        if (rating === undefined && is_favorite === undefined) {
          throw new ToolInputError(
            'Give at least one of rating or is_favorite.'
          );
        }
        const { slug } = await resolveRecipe(api, recipe);
        // The rating route lives under the user, not under the recipe, and wants
        // the caller's own UUID in the path even though the token already
        // identifies them. Fetched once and cached for the process.
        const userId = assertPathSegment(await currentUser.id(), 'user id');
        const data = await api.post(
          `/api/users/${userId}/ratings/${assertPathSegment(slug, 'recipe')}`,
          {
            ...(rating === undefined ? {} : { rating }),
            ...(is_favorite === undefined ? {} : { isFavorite: is_favorite }),
          }
        );
        return untrustedResult(data);
      })
  );

  server.registerTool(
    'add_recipe_comment',
    {
      title: 'Comment on a recipe',
      description:
        'Adds a comment to a recipe. Comments are visible to everyone in the ' +
        'group and are attributed to the user the API token belongs to.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        text: z.string().trim().min(1).max(10_000),
      }),
      annotations: WRITE,
    },
    async ({ recipe, text }) =>
      run(async () => {
        const { id } = await resolveRecipe(api, recipe);
        const data = await api.post('/api/comments', {
          recipeId: id,
          text,
        });
        return untrustedResult(commentSummary(data));
      })
  );

  server.registerTool(
    'delete_recipe_comment',
    {
      title: 'Delete a recipe comment',
      description:
        'Deletes a comment. Requires confirmation: call once to receive a token, ' +
        'then again with that token.',
      inputSchema: z.object({
        comment_id: uuidParam.describe(
          'Comment UUID, from list_recipe_comments'
        ),
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ comment_id, confirm_token }, mcp) =>
      run(async () => {
        const key = `delete_recipe_comment:${comment_id}`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `delete the comment with id ${comment_id}`,
            consequence:
              'The comment is gone for good; Mealie keeps no history of it.',
            resourceKey: key,
            token: confirm_token,
            toolName: 'delete_recipe_comment',
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
            `The user declined. delete_recipe_comment did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;
        await api.delete(`/api/comments/${comment_id}`);
        return textResult(`Deleted the comment with id ${comment_id}.`);
      })
  );

  server.registerTool(
    'create_timeline_event',
    {
      title: 'Add a timeline entry',
      description:
        "Adds an entry to a recipe's timeline — typically a note about having " +
        'cooked it and how it turned out. Pair it with set_recipe_last_made, ' +
        'which is what the recipe view sorts on.',
      inputSchema: z.object({
        recipe: recipeRefParam,
        subject: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .describe('Short headline, e.g. "Cooked it"'),
        message: z.string().max(10_000).optional().describe('The note itself'),
        timestamp: z
          .string()
          .trim()
          .regex(
            /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/,
            'must be an ISO 8601 date or date-time'
          )
          .optional()
          .describe('When it happened; defaults to now'),
      }),
      annotations: WRITE,
    },
    async ({ recipe, subject, message, timestamp }) =>
      run(async () => {
        const { id } = await resolveRecipe(api, recipe);
        const userId = await currentUser.id();
        const data = await api.post('/api/recipes/timeline/events', {
          recipeId: id,
          userId,
          subject,
          // "comment" is the type Mealie uses for entries a person wrote;
          // "system" is reserved for the events it generates itself.
          eventType: 'comment',
          ...(message === undefined ? {} : { eventMessage: message }),
          ...(timestamp === undefined ? {} : { timestamp }),
        });
        return untrustedResult(timelineEvent(data));
      })
  );
}
