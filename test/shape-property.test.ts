import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isClean } from '../src/text.js';
import { connect } from './harness.js';

/**
 * Every read tool, fed whatever JSON an instance might answer with, through
 * the whole server — the SDK's client-side output-schema check included,
 * since `connect()` lists the tools first.
 *
 * On SDK 2.0 a result that fails its own `outputSchema` is not a protocol
 * error but an `isError` answer reading `Output validation error: …`, and a
 * listing loses every good element to one bad one. A `null` where an object
 * belongs used to answer `Cannot read properties of null`; a 300 kB string
 * where a nutrition value belongs used to make the recipe unanswerable. The
 * three sentences asserted absent below are the three ways that shows.
 *
 * `SHAPE_RUNS` raises the run count for a deep local pass; CI keeps it small.
 */

const RUNS = Number(process.env.SHAPE_RUNS ?? 20);
const UUID = '11111111-1111-4111-8111-111111111111';

/** The read tools and the smallest valid argument set for each. */
const READ_CALLS: [string, Record<string, unknown>][] = [
  ['get_about', {}],
  ['get_cookbook', { cookbook: 'weeknight' }],
  ['get_recipe', { recipe: 'quark-bowl' }],
  ['get_recipe', { recipe: 'quark-bowl', detail: 'raw' }],
  ['get_shopping_list', { list_id: UUID }],
  ['get_todays_meals', {}],
  ['list_cookbooks', {}],
  ['list_foods', {}],
  ['list_mealplans', {}],
  ['list_organizers', { kind: 'tag' }],
  ['list_recipe_comments', { recipe: 'quark-bowl' }],
  ['list_recipe_timeline', { recipe: 'quark-bowl' }],
  ['list_share_tokens', {}],
  ['list_shopping_lists', {}],
  ['list_units', {}],
  ['parse_ingredients', { ingredients: ['2 tbsp olive oil'] }],
  ['search_recipes', {}],
  ['suggest_recipes', {}],
];

/** A leaf an instance might put where a string, a number or a list belongs. */
const leaf = fc.oneof(
  fc.jsonValue({ maxDepth: 2 }),
  fc.double(),
  fc.constant(null),
  fc.string({ maxLength: 700, unit: 'binary' }),
  fc.constant('x'.repeat(30_000)),
  fc.constant(-9007199254740992),
  fc.constant({ toString: 'constructor' }),
  fc.constant([]),
  fc.constant({})
);

/** The shapes the projections read, with random leaves in every slot. */
const record = fc.record(
  {
    id: leaf,
    slug: leaf,
    name: leaf,
    description: leaf,
    image: leaf,
    rating: leaf,
    recipeServings: leaf,
    totalTime: leaf,
    tags: fc.oneof(
      leaf,
      fc.array(fc.record({ id: leaf, name: leaf, slug: leaf }))
    ),
    recipeCategory: leaf,
    recipeIngredient: fc.oneof(
      leaf,
      fc.array(
        fc.record({ note: leaf, quantity: leaf, unit: leaf, food: leaf })
      )
    ),
    recipeInstructions: fc.oneof(leaf, fc.array(fc.record({ text: leaf }))),
    nutrition: fc.oneof(leaf, fc.dictionary(fc.string(), leaf)),
    notes: leaf,
    listItems: fc.oneof(leaf, fc.array(fc.record({ id: leaf, note: leaf }))),
    recipe: leaf,
    user: leaf,
    label: leaf,
    orgURL: leaf,
    extras: fc.oneof(leaf, fc.dictionary(fc.string(), leaf)),
    truncated: leaf,
    untrusted: leaf,
    source: leaf,
    __proto__: leaf,
    version: leaf,
    group: leaf,
    username: leaf,
  },
  { requiredKeys: [] }
);

const body = fc.oneof(
  fc.jsonValue({ maxDepth: 3 }),
  record,
  fc.record({
    items: fc.array(record, { maxLength: 4 }),
    page: leaf,
    total: leaf,
  }),
  fc.array(record, { maxLength: 4 })
);

/** Serialised, with a `1e999` — Infinity to `JSON.parse` — spliced in sometimes. */
const bodyText = fc.tuple(body, fc.boolean()).map(([value, spike]) => {
  const text = JSON.stringify(value);
  return spike ? text.replace(/:(\s*)[0-9.-]+([,}\]])/, ':$11e999$2') : text;
});

const FORBIDDEN = [
  'Output validation error',
  'Cannot read properties',
  'is not a function',
  'is not iterable',
  'Maximum call stack',
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('no answer an instance can give breaks a read tool', () => {
  for (const [name, args] of READ_CALLS) {
    it(`${name} ${JSON.stringify(args)}`, async () => {
      const client = await connect();
      await fc.assert(
        fc.asyncProperty(bodyText, async (text) => {
          vi.spyOn(globalThis, 'fetch').mockImplementation(
            async () =>
              new Response(text, {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
          );
          const result = await client.callTool({ name, arguments: args });
          const content = (result.content as { text?: string }[])
            .map((c) => c.text ?? '')
            .join('\n');
          for (const sentence of FORBIDDEN) {
            expect(content, sentence).not.toContain(sentence);
          }
          // Whatever came back, nothing in it may carry a control character
          // or a direction override — the instance's text is cleaned before
          // it is shown.
          expect(isClean(content)).toBe(true);
          // And on a success, both channels say the same thing.
          if (!result.isError) {
            const json = content.slice(content.indexOf('{'));
            expect(JSON.parse(json)).toEqual(result.structuredContent);
          }
          vi.restoreAllMocks();
        }),
        { numRuns: RUNS }
      );
      await client.close();
    });
  }
});
