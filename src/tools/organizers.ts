import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  orderDirectionParam,
  pageParam,
  perPageParam,
  uuidParam,
} from '../schema.js';

import { query, type MealieApi } from '../api.js';
import { contentFingerprint } from '../fingerprint.js';
import { DESTRUCTIVE, READ_ONLY, WRITE } from './annotations.js';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import { errorResult, run, textResult, untrustedResult } from '../result.js';
import { listFrom, organizerSummary, paginationOf } from '../shape.js';

/**
 * Tags, categories and recipe tools share one CRUD shape in Mealie — the only
 * differences are the path and the fact that a tool additionally carries
 * `onHand`. Three separate sets of tools would be twelve entries in the catalog
 * saying the same thing, so the kind is a parameter.
 */
const KINDS = {
  tag: {
    path: '/api/organizers/tags',
    label: 'tag',
    plural: 'tags',
    consequence: 'It is removed from every recipe that carries it.',
  },
  category: {
    path: '/api/organizers/categories',
    label: 'category',
    plural: 'categories',
    consequence: 'It is removed from every recipe that carries it.',
  },
  tool: {
    path: '/api/organizers/tools',
    label: 'tool',
    plural: 'tools',
    consequence: 'It is removed from every recipe that requires it.',
  },
} as const;

type Kind = keyof typeof KINDS;

const kindParam = z
  .enum(['tag', 'category', 'tool'])
  .describe(
    'Which organizer: "tag" (free-form labels), "category" (the primary ' +
      'classification, one recipe usually has few) or "tool" (equipment a ' +
      'recipe needs)'
  );

export function registerOrganizerReadTools(
  server: McpServer,
  api: MealieApi
): void {
  server.registerTool(
    'list_organizers',
    {
      title: 'List tags, categories or tools',
      description:
        'Lists the tags, categories or tools defined in the group, with their ' +
        'ids and slugs. These are the values search_recipes filters on.',
      inputSchema: z.object({
        kind: kindParam,
        search: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Filter by name'),
        page: pageParam,
        per_page: perPageParam(100),
        order_direction: orderDirectionParam,
      }),
      annotations: READ_ONLY,
    },
    async ({ kind, search, page, per_page, order_direction }) =>
      run(async () => {
        const spec = KINDS[kind as Kind];
        const data = await api.get(
          `${spec.path}${query({
            search,
            page,
            perPage: per_page ?? 100,
            orderBy: 'name',
            orderDirection: order_direction ?? 'asc',
          })}`
        );
        return untrustedResult({
          kind,
          ...paginationOf(data),
          [spec.plural]: listFrom(data).map(organizerSummary),
        });
      })
  );
}

export function registerOrganizerWriteTools(
  server: McpServer,
  api: MealieApi,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_organizer',
    {
      title: 'Create a tag, category or tool',
      description:
        'Creates a tag, category or recipe tool. Assigning one to a recipe with ' +
        'update_recipe already creates it on the fly — this tool is for defining ' +
        'one up front.',
      inputSchema: z.object({
        kind: kindParam,
        name: z.string().trim().min(1).max(255),
      }),
      annotations: WRITE,
    },
    async ({ kind, name }) =>
      run(async () => {
        const spec = KINDS[kind as Kind];
        const data = await api.post(spec.path, { name });
        return untrustedResult({ kind, ...organizerSummary(data) });
      })
  );

  server.registerTool(
    'update_organizer',
    {
      title: 'Rename a tag, category or tool',
      description:
        'Renames a tag, category or tool. Mealie regenerates the slug from the ' +
        'new name, so anything referring to the old slug stops matching. ' +
        'Requires confirmation: call once to receive a token, then again with ' +
        'that token.',
      inputSchema: z.object({
        kind: kindParam,
        id: uuidParam.describe('UUID from list_organizers'),
        name: z.string().trim().min(1).max(255).describe('The new name'),
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ kind, id, name, confirm_token }, mcp) =>
      run(async () => {
        const spec = KINDS[kind as Kind];
        // The tool's own description is the argument for the guard: the rename
        // takes the slug with it, and everything that referred to the old one —
        // a cookbook's saved filter, a bookmark, a search someone wrote down —
        // stops matching without any of them being touched or told.
        const key = `update_organizer:${kind}:${id}:${contentFingerprint({ name })}`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `rename the ${spec.label} with id ${id}`,
            consequence:
              'Mealie regenerates the slug from the new name. Cookbook filters, ' +
              'links and saved searches that refer to the old slug stop matching, ' +
              'and the old name is not kept anywhere.',
            // The new name is the caller's text, so it goes on its own labelled
            // line rather than into the server's sentence above.
            details: [{ label: 'New name', value: name }],
            resourceKey: key,
            token: confirm_token,
            toolName: 'update_organizer',
            hint: 'Tick to rename it, leave it to cancel.',
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
            `The user declined. update_organizer did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;
        const data = await api.put(`${spec.path}/${id}`, { name });
        return untrustedResult({ kind, ...organizerSummary(data) });
      })
  );

  server.registerTool(
    'delete_organizer',
    {
      title: 'Delete a tag, category or tool',
      description:
        'Deletes a tag, category or tool. The recipes themselves are kept, but ' +
        'they lose the assignment. Requires confirmation: call once to receive a ' +
        'token, then again with that token.',
      inputSchema: z.object({
        kind: kindParam,
        id: uuidParam.describe('UUID from list_organizers'),
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ kind, id, confirm_token }, mcp) =>
      run(async () => {
        const spec = KINDS[kind as Kind];
        const key = `delete_organizer:${kind}:${id}`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `delete the ${spec.label} with id ${id}`,
            consequence: spec.consequence,
            resourceKey: key,
            token: confirm_token,
            toolName: 'delete_organizer',
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
            `The user declined. delete_organizer did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;
        await api.delete(`${spec.path}/${id}`);
        return textResult(`Deleted the ${spec.label} with id ${id}.`);
      })
  );
}
