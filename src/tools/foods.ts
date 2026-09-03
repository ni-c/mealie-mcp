import { z } from 'zod';
import { marked } from '../output-schema.js';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  orderDirectionParam,
  pageParam,
  perPageParam,
  uuidParam,
} from '../schema.js';

import { query, type MealieApi } from '../api.js';
import { DESTRUCTIVE, READ_ONLY, WRITE } from './annotations.js';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import { errorResult, run, untrustedResult } from '../result.js';
import { foodSummary, listFrom, paginationOf, unitSummary } from '../shape.js';

export function registerFoodReadTools(server: McpServer, api: MealieApi): void {
  server.registerTool(
    'list_foods',
    {
      title: 'List foods',
      description:
        'Lists the structured foods of the group — the ingredient vocabulary ' +
        'Mealie matches ingredient lines against. Many instances leave this ' +
        'empty and keep ingredients as plain text; an empty result means exactly ' +
        'that, not a failure.',
      inputSchema: z.object({
        search: z.string().trim().min(1).max(200).optional(),
        page: pageParam,
        per_page: perPageParam(100),
        order_direction: orderDirectionParam,
      }),
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async ({ search, page, per_page, order_direction }) =>
      run(async () => {
        const data = await api.get(
          `/api/foods${query({
            search,
            page,
            perPage: per_page ?? 100,
            orderBy: 'name',
            orderDirection: order_direction ?? 'asc',
          })}`
        );
        return untrustedResult({
          ...paginationOf(data),
          foods: listFrom(data).map(foodSummary),
        });
      })
  );

  server.registerTool(
    'list_units',
    {
      title: 'List units',
      description:
        'Lists the measurement units of the group, with their abbreviations. ' +
        'Like foods, this is empty on an instance that never seeded them.',
      inputSchema: z.object({
        search: z.string().trim().min(1).max(200).optional(),
        page: pageParam,
        per_page: perPageParam(100),
        order_direction: orderDirectionParam,
      }),
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async ({ search, page, per_page, order_direction }) =>
      run(async () => {
        const data = await api.get(
          `/api/units${query({
            search,
            page,
            perPage: per_page ?? 100,
            orderBy: 'name',
            orderDirection: order_direction ?? 'asc',
          })}`
        );
        return untrustedResult({
          ...paginationOf(data),
          units: listFrom(data).map(unitSummary),
        });
      })
  );

  server.registerTool(
    'parse_ingredients',
    {
      title: 'Parse ingredient lines',
      description:
        'Splits free-text ingredient lines into quantity, unit, food and note, ' +
        'and reports how confident Mealie is about each part. Nothing is saved. ' +
        'Use it to check how a line will be understood before writing it to a ' +
        'recipe or a shopping list.',
      inputSchema: z.object({
        ingredients: z
          .array(z.string().trim().min(1).max(1000))
          .min(1)
          .max(100)
          .describe('Ingredient lines, e.g. "2 tbsp olive oil"'),
        parser: z
          .enum(['nlp', 'brute'])
          .optional()
          .describe(
            '"nlp" (default) uses the trained model, "brute" a rule-based split. ' +
              'Mealie also offers an "openai" parser; it is not exposed here ' +
              'because it sends every line to an external provider.'
          ),
      }),
      annotations: READ_ONLY,
      outputSchema: marked(),
    },
    async ({ ingredients, parser }) =>
      run(async () => {
        const data = await api.post('/api/parser/ingredients', {
          parser: parser ?? 'nlp',
          ingredients,
        });
        return untrustedResult(data);
      })
  );
}

export function registerFoodWriteTools(
  server: McpServer,
  api: MealieApi,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'create_food',
    {
      title: 'Create food',
      description:
        'Adds a food to the group vocabulary so ingredient lines can be matched ' +
        'against it.',
      inputSchema: z.object({
        name: z.string().trim().min(1).max(255),
        plural_name: z.string().trim().min(1).max(255).optional(),
        description: z.string().max(2000).optional(),
        label_id: uuidParam
          .optional()
          .describe('Shopping-list label to file this food under'),
      }),
      annotations: WRITE,
      outputSchema: marked(),
    },
    async ({ name, plural_name, description, label_id }) =>
      run(async () => {
        const data = await api.post('/api/foods', {
          name,
          ...(plural_name === undefined ? {} : { pluralName: plural_name }),
          ...(description === undefined ? {} : { description }),
          ...(label_id === undefined ? {} : { labelId: label_id }),
        });
        return untrustedResult(foodSummary(data));
      })
  );

  server.registerTool(
    'create_unit',
    {
      title: 'Create unit',
      description: 'Adds a measurement unit to the group vocabulary.',
      inputSchema: z.object({
        name: z.string().trim().min(1).max(255),
        plural_name: z.string().trim().min(1).max(255).optional(),
        abbreviation: z.string().trim().min(1).max(50).optional(),
        use_abbreviation: z
          .boolean()
          .optional()
          .describe('Render the abbreviation instead of the name'),
        fraction: z
          .boolean()
          .optional()
          .describe(
            'Show quantities as fractions (½ cup) rather than decimals'
          ),
        description: z.string().max(2000).optional(),
      }),
      annotations: WRITE,
      outputSchema: marked(),
    },
    async ({
      name,
      plural_name,
      abbreviation,
      use_abbreviation,
      fraction,
      description,
    }) =>
      run(async () => {
        const data = await api.post('/api/units', {
          name,
          ...(plural_name === undefined ? {} : { pluralName: plural_name }),
          ...(abbreviation === undefined ? {} : { abbreviation }),
          ...(use_abbreviation === undefined
            ? {}
            : { useAbbreviation: use_abbreviation }),
          ...(fraction === undefined ? {} : { fraction }),
          ...(description === undefined ? {} : { description }),
        });
        return untrustedResult(unitSummary(data));
      })
  );

  registerMerge(server, api, confirmations, approval, 'food');
  registerMerge(server, api, confirmations, approval, 'unit');
}

/**
 * Merging rewrites every reference from one record to another and deletes the
 * source. There is no undo, and the direction matters — swapping the two
 * arguments destroys the wrong record — so the confirmation token is bound to
 * the ordered pair rather than to the set.
 */
function registerMerge(
  server: McpServer,
  api: MealieApi,
  confirmations: ConfirmationStore,
  approval: Approver,
  kind: 'food' | 'unit'
): void {
  const plural = kind === 'food' ? 'foods' : 'units';
  server.registerTool(
    `merge_${plural}`,
    {
      title: `Merge ${plural}`,
      description:
        `Points every ingredient that uses one ${kind} at another one and ` +
        `deletes the source ${kind}. Requires confirmation: call once to ` +
        'receive a token, then again with that token.',
      inputSchema: z.object({
        from_id: uuidParam.describe(
          `UUID of the ${kind} to merge away — this one is deleted`
        ),
        to_id: uuidParam.describe(
          `UUID of the ${kind} to keep — references end up here`
        ),
        confirm_token: confirmTokenParam,
      }),
      annotations: DESTRUCTIVE,
      outputSchema: marked(),
    },
    async ({ from_id, to_id, confirm_token }, mcp) =>
      run(async () => {
        // Not setResourceKey's sorted fingerprint: the order IS the meaning here.
        const key = `merge_${plural}:${from_id}->${to_id}`;
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `merge the ${kind} ${from_id} into ${to_id}`,
            consequence: `The ${kind} ${from_id} is deleted and every reference to it is rewritten. This cannot be undone.`,
            resourceKey: key,
            token: confirm_token,
            toolName: `merge_${plural}`,
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
          return errorResult(`The user declined. merge_${plural} did nothing.`);
        }
        if (outcome.decision === 'pending') return outcome.result;
        const body =
          kind === 'food'
            ? { fromFood: from_id, toFood: to_id }
            : { fromUnit: from_id, toUnit: to_id };
        const data = await api.put(`/api/${plural}/merge`, body);
        return untrustedResult({
          merged: { from: from_id, into: to_id },
          result: kind === 'food' ? foodSummary(data) : unitSummary(data),
        });
      })
  );
}
