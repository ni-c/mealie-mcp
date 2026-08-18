import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { assertPathSegment, type MealieApi } from '../api.js';
import { confirmationPrompt, type ConfirmationStore } from '../confirm.js';
import { resolveRecipe, type CurrentUser } from '../lookup.js';
import { run, textResult, ToolInputError, untrustedResult } from '../result.js';
import { confirmTokenParam, recipeRefParam, uuidParam } from '../schema.js';
import { commentSummary, timelineEvent } from '../shape.js';

export function registerEngagementWriteTools(
  server: McpServer,
  api: MealieApi,
  currentUser: CurrentUser,
  confirmations: ConfirmationStore
): void {
  server.registerTool(
    'set_recipe_rating',
    {
      title: 'Rate a recipe',
      description:
        'Sets the personal rating of a recipe and/or marks it as a favourite. ' +
        'Ratings in Mealie are per user, not per recipe.',
      inputSchema: {
        recipe: recipeRefParam,
        rating: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .describe('Stars from 0 to 5; 0 clears the rating'),
        is_favorite: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
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
        const userId = await currentUser.id();
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
      inputSchema: {
        recipe: recipeRefParam,
        text: z.string().trim().min(1).max(10_000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
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
      inputSchema: {
        comment_id: uuidParam.describe(
          'Comment UUID, from list_recipe_comments'
        ),
        confirm_token: confirmTokenParam,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ comment_id, confirm_token }) =>
      run(async () => {
        const key = `delete_recipe_comment:${comment_id}`;
        if (!confirmations.consume(key, confirm_token)) {
          return textResult(
            confirmationPrompt(
              `delete the comment with id ${comment_id}`,
              confirmations.issue(key),
              confirmations.ttlMinutes
            )
          );
        }
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
      inputSchema: {
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
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
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
