import { afterEach, describe, expect, it, vi } from 'vitest';

import { planParse, unparsedText } from '../src/ingredients.js';
import { recipePatch } from '../src/tools/recipes.js';
import { callsOf, callText, confirmed, connect, tokenOf } from './harness.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const RECIPE_ID = '11111111-1111-4111-8111-111111111111';
const OIL = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'olive oil' };
const SALT = { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'salt' };
const EGG = {
  id: 'aaaaaaaa-0000-4000-8000-000000000003',
  name: 'egg',
  pluralName: 'eggs',
};
const SCALLION = {
  id: 'aaaaaaaa-0000-4000-8000-000000000004',
  name: 'spring onion',
  aliases: [{ name: 'scallion' }],
};
/** Lists "egg" as an alias, and comes first in Mealie's answer. */
const HENS_EGG = {
  id: 'aaaaaaaa-0000-4000-8000-000000000005',
  name: "hen's egg",
  aliases: [{ name: 'egg' }],
};
const TBSP = {
  id: 'bbbbbbbb-0000-4000-8000-000000000001',
  name: 'tablespoon',
  pluralName: 'tablespoons',
  abbreviation: 'tbsp',
};
const GRAM = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  name: 'gram',
  abbreviation: 'g',
};

/** A parser answer the way Mealie gives it: food without id = unknown. */
function parsed(
  input: string,
  parts: {
    quantity?: number;
    unit?: { id?: string | null; name: string } | null;
    food?: { id?: string | null; name: string } | null;
    note?: string;
    confidence?: number;
  }
) {
  return {
    input,
    confidence: { average: parts.confidence ?? 0.99 },
    ingredient: {
      quantity: parts.quantity ?? 0,
      unit: parts.unit ?? null,
      food: parts.food ?? null,
      note: parts.note ?? '',
      display: input,
    },
  };
}

describe('unparsedText', () => {
  it('reads the note of a line nobody structured', () => {
    expect(unparsedText({ note: ' 2 tbsp olive oil ', quantity: 0 })).toBe(
      '2 tbsp olive oil'
    );
  });

  it('falls back to originalText, then display, when the note is empty', () => {
    expect(unparsedText({ note: '', originalText: '1 egg' })).toBe('1 egg');
    expect(unparsedText({ note: null, display: 'salt' })).toBe('salt');
  });

  it('leaves alone a line that carries a food, a unit or a quantity', () => {
    expect(unparsedText({ note: 'x', food: SALT })).toBeUndefined();
    expect(unparsedText({ note: 'x', unit: TBSP })).toBeUndefined();
    expect(unparsedText({ note: 'x', quantity: 2 })).toBeUndefined();
  });

  it('leaves alone a line that points at another recipe', () => {
    expect(
      unparsedText({ note: 'the dough', referencedRecipe: { id: RECIPE_ID } })
    ).toBeUndefined();
  });

  it('treats a null quantity and null references as unparsed', () => {
    expect(
      unparsedText({ note: 'salt', quantity: null, food: null, unit: null })
    ).toBe('salt');
  });

  it('has nothing to parse in an empty line or a non-object', () => {
    expect(unparsedText({ note: '   ', title: 'Sauce' })).toBeUndefined();
    expect(unparsedText(null)).toBeUndefined();
    expect(unparsedText('2 eggs')).toBeUndefined();
  });
});

describe('planParse', () => {
  const current = [
    { note: '2 tbsp olive oil', quantity: 0, referenceId: 'r0', display: 'x' },
    { note: 'done', food: SALT, quantity: 1, referenceId: 'r1' },
    { note: '500 g quark', quantity: 0, title: 'Base', referenceId: 'r2' },
  ];
  const targets = [
    { index: 0, line: '2 tbsp olive oil' },
    { index: 2, line: '500 g quark' },
  ];

  it('writes a known food with a known unit and keeps the rest of the line', () => {
    const plan = planParse(
      current,
      targets,
      [
        parsed('2 tbsp olive oil', { quantity: 2, unit: TBSP, food: OIL }),
        parsed('500 g quark', {
          quantity: 500,
          unit: GRAM,
          food: { name: 'quark' },
        }),
      ],
      0.9
    );
    expect(plan.ingredients[0]).toEqual({
      note: '',
      quantity: 2,
      referenceId: 'r0',
      unit: { id: TBSP.id, name: 'tablespoon' },
      food: { id: OIL.id, name: 'olive oil' },
      originalText: '2 tbsp olive oil',
    });
    // Untouched lines go back exactly as they came, the structured one too.
    expect(plan.ingredients[1]).toBe(current[1]);
    expect(plan.ingredients[2]).toBe(current[2]);
    expect(plan.structured).toEqual([
      {
        index: 0,
        line: '2 tbsp olive oil',
        quantity: 2,
        unit: 'tablespoon',
        food: 'olive oil',
        note: '',
      },
    ]);
    expect(plan.undecided).toEqual([
      {
        index: 2,
        line: '500 g quark',
        reason: '"quark" is not one of this Mealie\'s foods',
        suggestion: {
          quantity: 500,
          unit: 'gram',
          unit_known: true,
          food: 'quark',
          food_known: false,
          note: '',
        },
        confidence: 0.99,
      },
    ]);
  });

  it('keeps an originalText that was already there', () => {
    const plan = planParse(
      [{ note: 'salt', originalText: 'Salt, to taste' }],
      [{ index: 0, line: 'salt' }],
      [parsed('salt', { food: SALT, note: 'to taste' })],
      0.9
    );
    expect(plan.ingredients[0]).toMatchObject({
      originalText: 'Salt, to taste',
      note: 'to taste',
      unit: null,
      quantity: 0,
    });
  });

  it('writes a line exactly at the threshold and holds one just below it', () => {
    const at = planParse(
      [{ note: 'salt' }],
      [{ index: 0, line: 'salt' }],
      [parsed('salt', { food: SALT, confidence: 0.9 })],
      0.9
    );
    expect(at.structured).toHaveLength(1);
    const below = planParse(
      [{ note: 'salt' }],
      [{ index: 0, line: 'salt' }],
      [parsed('salt', { food: SALT, confidence: 0.8999 })],
      0.9
    );
    expect(below.structured).toEqual([]);
    expect(below.undecided[0]!.reason).toBe(
      "the parser's confidence 0.899 is below 0.9"
    );
  });

  it('holds a line with no confidence at all unless a person decided it', () => {
    const result = { ingredient: { quantity: 1, food: SALT } };
    const held = planParse(
      [{ note: 'salt' }],
      [{ index: 0, line: 'salt' }],
      [result],
      0
    );
    expect(held.undecided[0]!.reason).toBe(
      'the parser reported no confidence for this line'
    );
    expect(held.undecided[0]!.confidence).toBeUndefined();
    const decided = planParse(
      [{ note: 'salt' }],
      [{ index: 0, line: 'salt' }],
      [result],
      0,
      new Map([[0, { food: SALT }]])
    );
    expect(decided.structured).toHaveLength(1);
  });

  it('holds a line whose unit is unknown, even with a known food', () => {
    const plan = planParse(
      [{ note: 'a knob of butter' }],
      [{ index: 0, line: 'a knob of butter' }],
      [
        parsed('a knob of butter', {
          quantity: 1,
          unit: { id: null, name: 'knob' },
          food: OIL,
        }),
      ],
      0.9
    );
    expect(plan.undecided[0]).toMatchObject({
      reason: '"knob" is not one of this Mealie\'s units',
      suggestion: { unit: 'knob', unit_known: false, food_known: true },
    });
  });

  it('holds a line in which the parser found no food', () => {
    const plan = planParse(
      [{ note: 'to serve' }],
      [{ index: 0, line: 'to serve' }],
      [parsed('to serve', { note: 'to serve' })],
      0
    );
    expect(plan.undecided[0]).toMatchObject({
      reason: 'the parser found no food in this line',
      suggestion: {
        food: null,
        food_known: false,
        unit: null,
        unit_known: true,
      },
    });
  });

  it('lets an override settle the food and the confidence, but not invent one', () => {
    const plan = planParse(
      [{ note: '1 pinch dragonfruit powder' }],
      [{ index: 0, line: '1 pinch dragonfruit powder' }],
      [
        parsed('1 pinch dragonfruit powder', {
          quantity: 1,
          unit: GRAM,
          food: { name: 'dragonfruit powder' },
          confidence: 0.2,
        }),
      ],
      0.9,
      new Map([[0, { food: SALT, unit: TBSP }]])
    );
    expect(plan.ingredients[0]).toMatchObject({
      quantity: 1,
      unit: { id: TBSP.id, name: 'tablespoon' },
      food: { id: SALT.id, name: 'salt' },
    });
  });

  it('reads garbage in a parser result as "nothing found", not as a crash', () => {
    const plan = planParse(
      [{ note: 'x' }],
      [{ index: 0, line: 'x' }],
      [
        {
          confidence: { average: Number.NaN },
          ingredient: {
            quantity: -3,
            food: { id: 'not-a-uuid', name: '  ' },
            unit: 'tbsp',
          },
        },
      ],
      0
    );
    expect(plan.undecided[0]).toMatchObject({
      reason: 'the parser found no food in this line',
      suggestion: { quantity: 0, unit: null, food: null },
      confidence: undefined,
    });
  });

  it('refuses an answer that does not line up with the lines sent', () => {
    expect(() =>
      planParse([{ note: 'x' }], [{ index: 0, line: 'x' }], [], 0)
    ).toThrow("Mealie's parser answered 0 results for 1 lines");
  });

  it('writes nothing for no targets', () => {
    const plan = planParse(current, [], [], 0.9);
    expect(plan).toEqual({
      ingredients: current,
      structured: [],
      undecided: [],
    });
  });
});

describe('recipePatch with structured lines', () => {
  const refs = {
    foods: new Map([['olive oil', OIL]]),
    units: new Map([['tbsp', { id: TBSP.id, name: TBSP.name }]]),
  };

  it('writes unit and food as references, and lets Mealie render display', () => {
    expect(
      recipePatch(
        {
          ingredients: [
            '1 lemon',
            {
              quantity: 2,
              unit: 'tbsp',
              food: 'olive oil',
              note: 'extra virgin',
              title: 'Dressing',
              original_text: '2 tbsp extra virgin olive oil',
            },
            { note: 'a handful of nuts' },
          ],
        },
        refs
      )
    ).toEqual({
      recipeIngredient: [
        { note: '1 lemon', display: '1 lemon', quantity: 0 },
        {
          quantity: 2,
          unit: { id: TBSP.id, name: 'tablespoon' },
          food: { id: OIL.id, name: 'olive oil' },
          note: 'extra virgin',
          title: 'Dressing',
          originalText: '2 tbsp extra virgin olive oil',
        },
        { quantity: 0, unit: null, food: null, note: 'a handful of nuts' },
      ],
    });
  });

  it('refuses to build a line whose food was never resolved', () => {
    expect(() => recipePatch({ ingredients: [{ food: 'quark' }] })).toThrow(
      '"quark" was not resolved'
    );
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A Mealie that answers by route, with a food and a unit vocabulary, one
 * recipe and a scripted parser.
 */
function fakeMealie(
  options: {
    recipeIngredient?: unknown[];
    parse?: (lines: string[]) => unknown;
    /** A vocabulary id whose lookup fails with HTTP 500. */
    failingId?: string;
  } = {}
) {
  const foods = [HENS_EGG, OIL, SALT, EGG, SCALLION];
  const units = [TBSP, GRAM];
  const recipe = {
    id: RECIPE_ID,
    slug: 'quark-bowl',
    name: 'Quark Bowl',
    recipeIngredient: options.recipeIngredient ?? [],
  };
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      for (const [path, list] of [
        ['/api/foods', foods],
        ['/api/units', units],
      ] as const) {
        if (url.pathname === path) {
          // Fuzzy the way Mealie is: a substring of any name matches.
          const term = (url.searchParams.get('search') ?? '').toLowerCase();
          const hits = (list as Record<string, unknown>[]).filter((item) =>
            JSON.stringify(item).toLowerCase().includes(term.slice(0, 3))
          );
          return json({ items: hits, total: hits.length });
        }
        if (url.pathname.startsWith(`${path}/`)) {
          const id = url.pathname.slice(path.length + 1);
          if (id === options.failingId) return json({ detail: 'boom' }, 500);
          const hit = (list as { id: string }[]).find((item) => item.id === id);
          return hit ? json(hit) : json({ detail: 'not found' }, 404);
        }
      }
      if (url.pathname === '/api/parser/ingredients') {
        return json(options.parse?.(body.ingredients as string[]) ?? []);
      }
      if (url.pathname === '/api/recipes' && method === 'POST') {
        return json('quark-bowl');
      }
      if (url.pathname === '/api/recipes' && method === 'GET') {
        return json({ items: [recipe], total: 1 });
      }
      if (url.pathname === '/api/recipes/quark-bowl' && method === 'PATCH') {
        return json({ ...recipe, ...body });
      }
      if (url.pathname === '/api/recipes/quark-bowl') return json(recipe);
      return json({ detail: `unrouted ${method} ${url.pathname}` }, 404);
    });
}

const writes = (spy: Parameters<typeof callsOf>[0]) =>
  callsOf(spy).filter(
    (call) => call.method !== 'GET' && !call.url.includes('/api/parser/')
  );

describe('structured ingredients through the tools', () => {
  it('resolves names, plurals, abbreviations, aliases and UUIDs before creating', async () => {
    const spy = fakeMealie();
    const { isError, text } = await callText(await connect(), 'create_recipe', {
      name: 'Quark Bowl',
      ingredients: [
        { quantity: 2, unit: 'TBSP', food: 'Olive Oil' },
        { quantity: 3, food: 'eggs' },
        { quantity: 1, food: 'scallion' },
        { quantity: 5, unit: GRAM.id, food: SALT.id },
      ],
    });
    expect(isError, text).toBe(false);
    const patch = callsOf(spy).find((call) => call.method === 'PATCH');
    expect(patch!.body).toEqual({
      recipeIngredient: [
        {
          quantity: 2,
          unit: { id: TBSP.id, name: 'tablespoon' },
          food: { id: OIL.id, name: 'olive oil' },
          note: '',
        },
        {
          quantity: 3,
          unit: null,
          food: { id: EGG.id, name: 'egg' },
          note: '',
        },
        {
          quantity: 1,
          unit: null,
          food: { id: SCALLION.id, name: 'spring onion' },
          note: '',
        },
        {
          quantity: 5,
          unit: { id: GRAM.id, name: 'gram' },
          food: { id: SALT.id, name: 'salt' },
          note: '',
        },
      ],
    });
  });

  it('prefers a food named so over one that only lists it as an alias', async () => {
    const spy = fakeMealie();
    await callText(await connect(), 'create_recipe', {
      name: 'Quark Bowl',
      ingredients: [{ quantity: 1, food: 'egg' }],
    });
    const patch = callsOf(spy).find((call) => call.method === 'PATCH');
    expect(patch!.body).toMatchObject({
      recipeIngredient: [{ food: { id: EGG.id, name: 'egg' } }],
    });
  });

  it('looks a repeated name up once', async () => {
    const spy = fakeMealie();
    await callText(await connect(), 'create_recipe', {
      name: 'Quark Bowl',
      ingredients: [{ food: 'salt' }, { food: ' salt' }, { food: 'salt' }],
    });
    const lookups = callsOf(spy).filter((call) =>
      call.url.includes('/api/foods')
    );
    expect(lookups).toHaveLength(1);
  });

  it('names every unknown food at once and creates nothing', async () => {
    const spy = fakeMealie();
    const { isError, text } = await callText(await connect(), 'create_recipe', {
      name: 'Quark Bowl',
      ingredients: [
        { food: 'quark' },
        { food: 'salt' },
        // A UUID that is not there: Mealie would store this as no food at all.
        { food: 'aaaaaaaa-0000-4000-8000-0000000000ff' },
      ],
    });
    expect(isError).toBe(true);
    expect(text).toContain(
      'No food in this Mealie matches "quark", "aaaaaaaa-0000-4000-8000-0000000000ff"'
    );
    expect(text).toContain('create_food');
    expect(writes(spy)).toEqual([]);
  });

  it('passes a failing UUID lookup on as an error, not as "unknown"', async () => {
    // Only a 404 means the record is not there. A 500 is Mealie failing, and
    // telling the user to create a food that may well exist would be wrong.
    const spy = fakeMealie({ failingId: SALT.id });
    const { isError, text } = await callText(await connect(), 'create_recipe', {
      name: 'Quark Bowl',
      ingredients: [{ food: SALT.id }],
    });
    expect(isError).toBe(true);
    expect(text).not.toContain('No food in this Mealie matches');
    expect(text).toContain('500');
    expect(writes(spy)).toEqual([]);
  });

  it('reports an unknown unit with its own tool name', async () => {
    fakeMealie();
    const { isError, text } = await callText(await connect(), 'create_recipe', {
      name: 'Quark Bowl',
      ingredients: [{ quantity: 1, unit: 'knob', food: 'olive oil' }],
    });
    expect(isError).toBe(true);
    expect(text).toContain('No unit in this Mealie matches "knob"');
    expect(text).toContain('create_unit');
  });

  it('refuses an unknown food before the person is asked anything', async () => {
    const spy = fakeMealie();
    const client = await connect({}, 'accept');
    const { isError } = await callText(client, 'update_recipe', {
      recipe: 'quark-bowl',
      ingredients: [{ food: 'quark' }],
    });
    expect(isError).toBe(true);
    expect(client.prompts).toEqual([]);
    expect(writes(spy)).toEqual([]);
  });

  it('writes structured lines through update_recipe after confirmation', async () => {
    const spy = fakeMealie();
    const { isError } = await confirmed(await connect(), 'update_recipe', {
      recipe: 'quark-bowl',
      ingredients: ['a pinch of love', { quantity: 2, food: 'egg' }],
    });
    expect(isError).toBe(false);
    expect(writes(spy)).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        body: {
          recipeIngredient: [
            {
              note: 'a pinch of love',
              display: 'a pinch of love',
              quantity: 0,
            },
            {
              quantity: 2,
              unit: null,
              food: { id: EGG.id, name: 'egg' },
              note: '',
            },
          ],
        },
      }),
    ]);
  });

  it('rejects a structured line with neither food nor note', async () => {
    const spy = fakeMealie();
    const { isError } = await callText(await connect(), 'create_recipe', {
      name: 'Quark Bowl',
      ingredients: [{ quantity: 2, unit: 'tbsp' }],
    });
    expect(isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('search_recipes unparsed_only', () => {
  it('builds the filter itself', async () => {
    const spy = fakeMealie();
    await callText(await connect(), 'search_recipes', { unparsed_only: true });
    const url = new URL(callsOf(spy)[0]!.url);
    expect(url.searchParams.get('queryFilter')).toBe(
      'recipeIngredient.foodId IS NULL'
    );
  });

  it('sends no filter when it is false or absent', async () => {
    const spy = fakeMealie();
    await callText(await connect(), 'search_recipes', { unparsed_only: false });
    await callText(await connect(), 'search_recipes', {});
    for (const call of callsOf(spy)) {
      expect(new URL(call.url).searchParams.has('queryFilter')).toBe(false);
    }
  });
});

const LINES = [
  { note: '2 tbsp olive oil', quantity: 0, referenceId: 'r0' },
  { note: 'salt', quantity: 1, food: SALT, referenceId: 'r1' },
  { note: '500 g quark', quantity: 0, referenceId: 'r2' },
];
function parser(texts: string[]): unknown[] {
  return texts.map((text) =>
    text === '2 tbsp olive oil'
      ? parsed(text, { quantity: 2, unit: TBSP, food: OIL })
      : parsed(text, { quantity: 500, unit: GRAM, food: { name: 'quark' } })
  );
}

describe('parse_recipe_ingredients', () => {
  it('reports a dry run without asking and without writing', async () => {
    const spy = fakeMealie({ recipeIngredient: LINES, parse: parser });
    const client = await connect({}, 'accept');
    const { isError, text } = await callText(
      client,
      'parse_recipe_ingredients',
      { recipe: 'quark-bowl' }
    );
    expect(isError, text).toBe(false);
    expect(client.prompts).toEqual([]);
    expect(writes(spy)).toEqual([]);
    // Only the two unparsed lines went to the parser.
    const parse = callsOf(spy).find((call) =>
      call.url.includes('/api/parser/')
    );
    expect(parse!.body).toEqual({
      parser: 'nlp',
      ingredients: ['2 tbsp olive oil', '500 g quark'],
    });
    expect(text).toContain('"dry_run": true');
    expect(text).toContain('"written": false');
    expect(text).toContain('dry_run: false');
    // Inside the JSON text the quotes around the name are escaped.
    expect(text).toContain('quark\\" is not one of this Mealie\'s foods');
  });

  it('writes after confirmation, sending untouched lines back as they were', async () => {
    const spy = fakeMealie({ recipeIngredient: LINES, parse: parser });
    const { isError, text } = await confirmed(
      await connect(),
      'parse_recipe_ingredients',
      { recipe: 'quark-bowl', dry_run: false, parser: 'brute' }
    );
    expect(isError, text).toBe(false);
    expect(text).toContain('"written": true');
    const [patch] = writes(spy);
    expect(patch!.url).toContain('/api/recipes/quark-bowl');
    expect(patch!.body).toEqual({
      recipeIngredient: [
        {
          note: '',
          quantity: 2,
          referenceId: 'r0',
          unit: { id: TBSP.id, name: 'tablespoon' },
          food: { id: OIL.id, name: 'olive oil' },
          originalText: '2 tbsp olive oil',
        },
        LINES[1],
        LINES[2],
      ],
    });
    // The parser named in the call is the one that ran.
    const parse = callsOf(spy).find((call) =>
      call.url.includes('/api/parser/')
    );
    expect(parse!.body).toMatchObject({ parser: 'brute' });
  });

  it('applies an override after resolving it, and binds the token to it', async () => {
    const spy = fakeMealie({ recipeIngredient: LINES, parse: parser });
    const client = await connect();
    const first = await callText(client, 'parse_recipe_ingredients', {
      recipe: 'quark-bowl',
      dry_run: false,
      overrides: [{ index: 2, food: 'salt' }],
    });
    // The token for one choice does not carry over to another.
    const crossed = await callText(client, 'parse_recipe_ingredients', {
      recipe: 'quark-bowl',
      dry_run: false,
      overrides: [{ index: 2, food: 'egg' }],
      confirm_token: tokenOf(first.text),
    });
    expect(crossed.isError).toBe(true);
    expect(writes(spy)).toEqual([]);

    const done = await confirmed(client, 'parse_recipe_ingredients', {
      recipe: 'quark-bowl',
      dry_run: false,
      overrides: [{ index: 2, food: 'salt' }],
    });
    expect(done.isError, done.text).toBe(false);
    const [patch] = writes(spy);
    const written = (patch!.body as { recipeIngredient: unknown[] })
      .recipeIngredient;
    expect(written[2]).toMatchObject({
      quantity: 500,
      unit: { id: GRAM.id },
      food: { id: SALT.id, name: 'salt' },
      originalText: '500 g quark',
    });
  });

  it('binds the token to the set of overrides, not to the order they came in', async () => {
    const spy = fakeMealie({ recipeIngredient: LINES, parse: parser });
    const client = await connect();
    const first = await callText(client, 'parse_recipe_ingredients', {
      recipe: 'quark-bowl',
      dry_run: false,
      overrides: [
        { index: 2, food: 'salt' },
        { index: 0, food: 'olive oil', unit: 'tbsp' },
      ],
    });
    const second = await callText(client, 'parse_recipe_ingredients', {
      recipe: 'quark-bowl',
      dry_run: false,
      overrides: [
        { index: 0, food: 'olive oil', unit: 'tbsp' },
        { index: 2, food: 'salt' },
      ],
      confirm_token: tokenOf(first.text),
    });
    expect(second.isError, second.text).toBe(false);
    expect(writes(spy)).toHaveLength(1);
  });

  it('refuses an override for a line that is not unparsed, or named twice', async () => {
    fakeMealie({ recipeIngredient: LINES, parse: parser });
    const client = await connect();
    const parsedLine = await callText(client, 'parse_recipe_ingredients', {
      recipe: 'quark-bowl',
      overrides: [{ index: 1, food: 'salt' }],
    });
    expect(parsedLine.isError).toBe(true);
    expect(parsedLine.text).toContain('line 1, which is not an unparsed');
    const twice = await callText(client, 'parse_recipe_ingredients', {
      recipe: 'quark-bowl',
      overrides: [
        { index: 0, food: 'salt' },
        { index: 0, unit: 'tbsp' },
      ],
    });
    expect(twice.isError).toBe(true);
    expect(twice.text).toContain('names line 0 twice');
  });

  it('refuses an override naming a food that does not exist', async () => {
    fakeMealie({ recipeIngredient: LINES, parse: parser });
    const { isError, text } = await callText(
      await connect(),
      'parse_recipe_ingredients',
      { recipe: 'quark-bowl', overrides: [{ index: 2, food: 'quark' }] }
    );
    expect(isError).toBe(true);
    expect(text).toContain('No food in this Mealie matches "quark"');
  });

  it('says there is nothing to do without asking or parsing', async () => {
    const spy = fakeMealie({ recipeIngredient: [LINES[1]] });
    const client = await connect({}, 'accept');
    const { isError, text } = await callText(
      client,
      'parse_recipe_ingredients',
      { recipe: 'quark-bowl', dry_run: false }
    );
    expect(isError).toBe(false);
    expect(text).toContain('Nothing to parse');
    expect(client.prompts).toEqual([]);
    expect(callsOf(spy).every((call) => call.method === 'GET')).toBe(true);
  });

  it('has nothing to parse in a recipe without ingredients', async () => {
    const spy = fakeMealie({ recipeIngredient: [] });
    const { isError, text } = await callText(
      await connect(),
      'parse_recipe_ingredients',
      { recipe: 'quark-bowl', dry_run: false }
    );
    expect(isError).toBe(false);
    expect(text).toContain('"lines": 0');
    expect(text).toContain('Nothing to parse');
    expect(callsOf(spy).every((call) => call.method === 'GET')).toBe(true);
  });

  it('writes nothing when no line was good enough, even after approval', async () => {
    const spy = fakeMealie({
      recipeIngredient: [LINES[2]],
      parse: parser,
    });
    const { isError, text } = await confirmed(
      await connect(),
      'parse_recipe_ingredients',
      { recipe: 'quark-bowl', dry_run: false }
    );
    expect(isError).toBe(false);
    expect(text).toContain('"written": false');
    expect(text).toContain('Nothing was written.');
    expect(writes(spy)).toEqual([]);
  });

  it('refuses a parser answer that is not a list', async () => {
    const spy = fakeMealie({
      recipeIngredient: LINES,
      parse: () => ({ detail: 'oops' }),
    });
    const { isError, text } = await callText(
      await connect(),
      'parse_recipe_ingredients',
      { recipe: 'quark-bowl' }
    );
    expect(isError).toBe(true);
    expect(text).toContain('did not answer with a list');
    expect(writes(spy)).toEqual([]);
  });
});
