import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsOf, callText, confirmed, connect, mockFetch } from './harness.js';

/**
 * What the guard is for, asserted over the whole catalogue rather than tool by
 * tool.
 *
 * The gap this file exists to close was not a missing check in one handler. It
 * was that the line had been drawn along the wrong property: everything named
 * `delete_*` or `merge_*` was guarded, and the four `update_*` tools that
 * `annotations.ts` itself calls destructive — "content that a person wrote,
 * replaced with no way back" — went through without anything being asked.
 * `update_recipe {recipe, ingredients: [], instructions: []}` emptied a recipe
 * in one call, where `delete_recipe` on the same recipe cost two calls and a
 * token.
 *
 * A per-tool test would not have found that, because every per-tool test that
 * existed passed. These two claim something about the catalogue as a whole, so
 * a tool added later has to satisfy them or say why.
 */

const RECIPE_ID = '11111111-1111-4111-8111-111111111111';
const LIST_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

/**
 * Arguments that drive each destructive tool down its destructive path.
 *
 * Every tool the server annotates `destructiveHint: true` has to appear here.
 * That is the point: a new destructive tool cannot be added without deciding
 * what its guarded call looks like, which is the decision that was skipped.
 */
const DESTRUCTIVE_CALLS: Record<string, Record<string, unknown>> = {
  delete_cookbook: { cookbook_id: TARGET_ID },
  delete_mealplan_entry: { entry_id: 7 },
  delete_organizer: { kind: 'tag', id: TARGET_ID },
  delete_recipe: { recipe: 'quark-bowl' },
  delete_recipe_comment: { comment_id: TARGET_ID },
  delete_share_token: { token_id: TARGET_ID },
  delete_shopping_list: { list_id: TARGET_ID },
  delete_shopping_list_items: { item_ids: [TARGET_ID] },
  merge_foods: { from_id: TARGET_ID, to_id: OTHER_ID },
  merge_units: { from_id: TARGET_ID, to_id: OTHER_ID },
  update_mealplan_entry: { entry_id: 7, title: 'Replaced' },
  update_organizer: { kind: 'tag', id: TARGET_ID, name: 'Replaced' },
  update_recipe: { recipe: 'quark-bowl', instructions: [] },
  update_shopping_list_items: {
    list_id: LIST_ID,
    item_ids: [TARGET_ID],
    note: 'Replaced',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the destructive line and the guard follow each other', () => {
  it('gives every destructive tool a confirm_token to take', async () => {
    // The schema half. `update_recipe`, `update_organizer`,
    // `update_mealplan_entry` and `update_shopping_list_items` all carried
    // destructiveHint: true and had no way of accepting a confirmation at all,
    // which is a shape this assertion can see without calling anything.
    const { tools } = await (await connect()).listTools();
    const destructive = tools.filter(
      (tool) => tool.annotations?.destructiveHint === true
    );
    expect(destructive.length).toBeGreaterThan(0);
    for (const tool of destructive) {
      const properties = (
        tool.inputSchema as { properties?: Record<string, unknown> }
      ).properties;
      expect(properties, tool.name).toBeDefined();
      expect(Object.keys(properties!), tool.name).toContain('confirm_token');
    }
  });

  it('covers every destructive tool with a call in this file', async () => {
    const { tools } = await (await connect()).listTools();
    const destructive = tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(destructive).toEqual(Object.keys(DESTRUCTIVE_CALLS).sort());
  });

  it('writes nothing on the first call of any destructive tool', async () => {
    // The behavioural half, and the one that would have caught the gap on its
    // own: reads are allowed before the question — resolving a slug to an id is
    // how the resource key is built — but nothing may be *changed* until
    // somebody has answered.
    for (const [name, args] of Object.entries(DESTRUCTIVE_CALLS)) {
      const spy = mockFetch();
      const client = await connect();
      const { text, isError } = await callText(client, name, args);
      const written = callsOf(spy).filter((call) => call.method !== 'GET');
      expect(written, `${name} wrote before asking`).toEqual([]);
      // The prompt is an error result: what was asked for did not happen, and
      // a tool that declares an `outputSchema` may not answer without
      // `structuredContent` unless the result is an error.
      expect(isError, name).toBe(true);
      // Without an elicitation-capable client the guard falls back to the
      // two-call token, so the first call has to hand one back.
      expect(text, name).toContain('confirm_token');
      vi.restoreAllMocks();
    }
  });

  it('asks a person who can be asked, on every destructive tool', async () => {
    // The other path: a client that declared elicitation is asked, and the
    // prompt has to name a consequence rather than just the operation.
    for (const [name, args] of Object.entries(DESTRUCTIVE_CALLS)) {
      mockFetch();
      const client = await connect({}, 'accept');
      await callText(client, name, args);
      expect(client.prompts, name).toHaveLength(1);
      expect(client.prompts[0]!.length, name).toBeGreaterThan(40);
      vi.restoreAllMocks();
    }
  });

  it('does nothing at all when the person says no', async () => {
    for (const [name, args] of Object.entries(DESTRUCTIVE_CALLS)) {
      const spy = mockFetch();
      const client = await connect({}, 'decline');
      const { isError } = await callText(client, name, args);
      expect(isError, name).toBe(true);
      expect(
        callsOf(spy).filter((call) => call.method !== 'GET'),
        `${name} acted after a refusal`
      ).toEqual([]);
      vi.restoreAllMocks();
    }
  });
});

describe('update_recipe', () => {
  it('guards a call that replaces written content', async () => {
    const spy = mockFetch();
    const result = await confirmed(await connect(), 'update_recipe', {
      recipe: 'quark-bowl',
      ingredients: [],
      instructions: [],
    });
    expect(result.prompt).toContain('no version history');
    expect(result.prompt).toContain('ingredients, instructions');
    // Keyed by the resolved id, like delete_recipe, so a token issued for a
    // slug cannot be spent on whatever holds that slug later.
    expect(result.prompt).toContain(RECIPE_ID);
    const patch = callsOf(spy).find((call) => call.method === 'PATCH');
    expect(patch!.body).toEqual({
      recipeIngredient: [],
      recipeInstructions: [],
    });
  });

  it('leaves a call that only changes settings alone', async () => {
    // Times, servings and yield are measurements, not something a person wrote
    // out. Guarding those as well would teach whoever answers the dialog to
    // stop reading it.
    const spy = mockFetch();
    const { text, isError } = await callText(await connect(), 'update_recipe', {
      recipe: 'quark-bowl',
      servings: 4,
      prep_time: '10',
      source_url: 'https://example.com/recipe',
    });
    expect(isError).toBe(false);
    expect(text).not.toContain('confirm_token');
    expect(callsOf(spy)[0]).toMatchObject({
      method: 'PATCH',
      body: { recipeServings: 4, prepTime: '10' },
    });
  });

  it('creates no tags while the replacement is still unconfirmed', async () => {
    // buildRecipePatch creates the tags it cannot find. Asking after building
    // the patch would leave those behind even when the answer is no, so the
    // question comes first.
    const spy = mockFetch();
    const { text } = await callText(await connect(), 'update_recipe', {
      recipe: 'quark-bowl',
      tags: ['A Tag That Does Not Exist'],
    });
    expect(text).toContain('confirm_token');
    expect(callsOf(spy).filter((call) => call.method === 'POST')).toEqual([]);
  });

  it('will not let a confirmation for one body write a different one', async () => {
    // The resource key carries a fingerprint of the replacing values, so the
    // token handed back for "rest overnight" cannot be quoted against a call
    // that clears the list instead.
    mockFetch();
    const client = await connect();
    const first = await callText(client, 'update_recipe', {
      recipe: 'quark-bowl',
      instructions: ['Rest overnight.'],
    });
    const token = /confirm_token="([0-9a-f]+)"/.exec(first.text)![1]!;
    const spy = mockFetch();
    const crossed = await callText(client, 'update_recipe', {
      recipe: 'quark-bowl',
      instructions: [],
      confirm_token: token,
    });
    expect(crossed.isError).toBe(true);
    expect(callsOf(spy).filter((call) => call.method === 'PATCH')).toEqual([]);
  });
});

describe('update_shopping_list_items', () => {
  it('leaves ticking off and quantities alone', async () => {
    // The everyday call. A tick is a marker, and the tool would be unusable if
    // every "cross off the milk" needed a dialog.
    const item = { id: TARGET_ID, note: 'Milk', quantity: 3, checked: false };
    const spy = mockFetch([
      { listItems: [item] },
      { updatedItems: [{ ...item, checked: true }] },
    ]);
    const { text, isError } = await callText(
      await connect(),
      'update_shopping_list_items',
      { list_id: LIST_ID, item_ids: [item.id], checked: true, quantity: 2 }
    );
    expect(isError).toBe(false);
    expect(text).not.toContain('confirm_token');
    expect(callsOf(spy).find((call) => call.method === 'PUT')).toBeDefined();
  });

  it('guards replacing the text of every item named', async () => {
    const item = { id: TARGET_ID, note: 'Milk', quantity: 3, checked: false };
    const spy = mockFetch([{ listItems: [item] }, { updatedItems: [] }]);
    const result = await confirmed(
      await connect(),
      'update_shopping_list_items',
      { list_id: LIST_ID, item_ids: [item.id], note: 'Replaced' }
    );
    expect(result.prompt).toContain('Every item named gets the same new text');
    expect(result.prompt).toContain('New text: Replaced');
    expect(callsOf(spy).find((call) => call.method === 'PUT')!.body).toEqual([
      {
        ...item,
        shoppingListId: LIST_ID,
        note: 'Replaced',
        display: 'Replaced',
      },
    ]);
  });

  it('will not let a confirmation for one item cover two', async () => {
    mockFetch();
    const client = await connect();
    const first = await callText(client, 'update_shopping_list_items', {
      list_id: LIST_ID,
      item_ids: [TARGET_ID],
      note: 'Replaced',
    });
    const token = /confirm_token="([0-9a-f]+)"/.exec(first.text)![1]!;
    const spy = mockFetch();
    const crossed = await callText(client, 'update_shopping_list_items', {
      list_id: LIST_ID,
      item_ids: [TARGET_ID, OTHER_ID],
      note: 'Replaced',
      confirm_token: token,
    });
    expect(crossed.isError).toBe(true);
    expect(callsOf(spy).filter((call) => call.method === 'PUT')).toEqual([]);
  });
});

describe('update_mealplan_entry', () => {
  it('leaves a move to another day alone', async () => {
    const current = { id: 7, date: '2026-08-19', entryType: 'dinner' };
    const spy = mockFetch([current, current]);
    const { text, isError } = await callText(
      await connect(),
      'update_mealplan_entry',
      { entry_id: 7, date: '2026-08-20' }
    );
    expect(isError).toBe(false);
    expect(text).not.toContain('confirm_token');
    expect(callsOf(spy).find((call) => call.method === 'PUT')).toBeDefined();
  });

  it('guards replacing the written note of an entry', async () => {
    const current = {
      id: 7,
      date: '2026-08-19',
      title: 'Old',
      text: 'Old too',
    };
    const spy = mockFetch([current, current]);
    const result = await confirmed(await connect(), 'update_mealplan_entry', {
      entry_id: 7,
      text: 'Replaced',
    });
    expect(result.prompt).toContain('keeps no history');
    expect(callsOf(spy).find((call) => call.method === 'PUT')!.body).toEqual({
      ...current,
      text: 'Replaced',
    });
  });
});
