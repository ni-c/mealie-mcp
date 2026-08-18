import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

const config: Config = {
  url: 'https://mealie.example.com',
  token: 'test-token',
  acceptLanguage: undefined,
  insecureTls: false,
  readOnly: false,
};

const GENERIC = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'quark-bowl',
  name: 'Quark Bowl',
  items: [],
  listItems: [],
  recipeIngredient: [],
  recipeInstructions: [],
  tags: [],
  recipeCategory: [],
  tools: [],
  notes: [],
};

const TAG_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

afterEach(() => {
  vi.restoreAllMocks();
});

async function connect(): Promise<Client> {
  const server = createServer(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

function mockFetch(bodies: unknown[] | unknown = GENERIC) {
  const queue = Array.isArray(bodies) ? [...bodies] : undefined;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const payload = queue === undefined ? bodies : (queue.shift() ?? GENERIC);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function callsOf(spy: { mock: { calls: unknown[][] } }): Call[] {
  return spy.mock.calls.map(([url, init]) => {
    const request = (init ?? {}) as RequestInit;
    return {
      url: String(url),
      method: request.method ?? 'GET',
      body:
        typeof request.body === 'string'
          ? (JSON.parse(request.body) as unknown)
          : undefined,
    };
  });
}

async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { text?: string }[];
  return {
    text: content.map((c) => c.text ?? '').join('\n'),
    isError: Boolean(result.isError),
  };
}

function tokenOf(text: string): string {
  const match = /confirm_token="([0-9a-f]+)"/.exec(text);
  if (!match?.[1]) throw new Error(`no confirmation token in: ${text}`);
  return match[1];
}

/** Runs the two-call confirmation dance and returns the second result. */
async function confirmed(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError: boolean; prompt: string }> {
  const first = await callText(client, name, args);
  const second = await callText(client, name, {
    ...args,
    confirm_token: tokenOf(first.text),
  });
  return { ...second, prompt: first.text };
}

describe('organizer writes', () => {
  it('renames through PUT on the kind-specific path', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'update_organizer', {
      kind: 'category',
      id: TAG_ID,
      name: 'Desserts',
    });
    expect(callsOf(spy)[0]).toMatchObject({
      method: 'PUT',
      body: { name: 'Desserts' },
    });
    expect(callsOf(spy)[0]!.url).toContain(
      `/api/organizers/categories/${TAG_ID}`
    );
  });

  it('deletes each kind behind a confirmation', async () => {
    const client = await connect();
    for (const [kind, path, consequence] of [
      ['tag', 'tags', 'carries it'],
      ['category', 'categories', 'carries it'],
      ['tool', 'tools', 'requires it'],
    ]) {
      const spy = mockFetch();
      const result = await confirmed(client, 'delete_organizer', {
        kind,
        id: TAG_ID,
      });
      expect(result.prompt, kind).toContain(consequence);
      expect(result.isError, kind).toBe(false);
      const del = callsOf(spy).find((c) => c.method === 'DELETE');
      expect(del?.url, kind).toContain(`/api/organizers/${path}/${TAG_ID}`);
      vi.restoreAllMocks();
    }
  });

  it('keeps confirmations for different kinds apart', async () => {
    // Same id, different resource: a tag confirmation must not delete the tool.
    const spy = mockFetch();
    const client = await connect();
    const first = await callText(client, 'delete_organizer', {
      kind: 'tag',
      id: TAG_ID,
    });
    const crossed = await callText(client, 'delete_organizer', {
      kind: 'tool',
      id: TAG_ID,
      confirm_token: tokenOf(first.text),
    });
    expect(crossed.text).toContain('confirm_token=');
    expect(callsOf(spy).some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('food and unit writes', () => {
  it('renames the optional food fields', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'create_food', {
      name: 'Quark',
      plural_name: 'Quarks',
      description: 'Fresh cheese',
      label_id: TAG_ID,
    });
    expect(callsOf(spy)[0]!.body).toEqual({
      name: 'Quark',
      pluralName: 'Quarks',
      description: 'Fresh cheese',
      labelId: TAG_ID,
    });
  });

  it('sends only the name when nothing else was given', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'create_food', { name: 'Quark' });
    expect(callsOf(spy)[0]!.body).toEqual({ name: 'Quark' });
  });

  it('carries the unit rendering flags', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'create_unit', {
      name: 'Tablespoon',
      plural_name: 'Tablespoons',
      abbreviation: 'tbsp',
      use_abbreviation: true,
      fraction: false,
      description: 'x',
    });
    expect(callsOf(spy)[0]!.body).toEqual({
      name: 'Tablespoon',
      pluralName: 'Tablespoons',
      abbreviation: 'tbsp',
      useAbbreviation: true,
      fraction: false,
      description: 'x',
    });
  });

  it('merges units through the unit-specific field names', async () => {
    const spy = mockFetch();
    const result = await confirmed(await connect(), 'merge_units', {
      from_id: TAG_ID,
      to_id: OTHER_ID,
    });
    expect(result.isError).toBe(false);
    const put = callsOf(spy).find((c) => c.method === 'PUT')!;
    expect(put.url).toContain('/api/units/merge');
    expect(put.body).toEqual({ fromUnit: TAG_ID, toUnit: OTHER_ID });
  });

  it('warns that the source record disappears', async () => {
    mockFetch();
    const first = await callText(await connect(), 'merge_foods', {
      from_id: TAG_ID,
      to_id: OTHER_ID,
    });
    expect(first.text).toContain(`${TAG_ID} is deleted`);
    expect(first.text).toContain('cannot be undone');
  });
});

describe('meal plan writes', () => {
  it('stores a free-text entry without a recipe id', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'create_mealplan_entry', {
      date: '2026-08-19',
      entry_type: 'lunch',
      title: 'Leftovers',
      text: 'from yesterday',
    });
    expect(callsOf(spy)[0]!.body).toEqual({
      date: '2026-08-19',
      entryType: 'lunch',
      title: 'Leftovers',
      text: 'from yesterday',
    });
  });

  it('resolves the recipe to a UUID for a recipe entry', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'create_mealplan_entry', {
      date: '2026-08-19',
      entry_type: 'dinner',
      recipe: 'quark-bowl',
    });
    const calls = callsOf(spy);
    expect(calls[0]!.url).toContain('/api/recipes/quark-bowl');
    expect(calls[1]!.body).toMatchObject({ recipeId: GENERIC.id, title: '' });
  });

  it('asks Mealie to pick a random meal', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'create_random_meal', {
      date: '2026-08-20',
      entry_type: 'dinner',
    });
    expect(callsOf(spy)[0]!.url).toContain('/api/households/mealplans/random');
    expect(callsOf(spy)[0]!.body).toEqual({
      date: '2026-08-20',
      entryType: 'dinner',
    });
  });

  it('replaces the recipe behind an existing entry', async () => {
    const spy = mockFetch([
      { id: 7, date: '2026-08-19', entryType: 'dinner', recipeId: 'old' },
      GENERIC,
      {},
    ]);
    await callText(await connect(), 'update_mealplan_entry', {
      entry_id: 7,
      recipe: 'quark-bowl',
    });
    expect(callsOf(spy)[2]!.body).toMatchObject({ recipeId: GENERIC.id });
  });

  it('deletes an entry behind a confirmation and keeps the recipe', async () => {
    const spy = mockFetch();
    const result = await confirmed(await connect(), 'delete_mealplan_entry', {
      entry_id: 7,
    });
    expect(result.prompt).toContain('recipe itself is kept');
    expect(result.text).toContain('Removed meal plan entry 7');
    expect(callsOf(spy).find((c) => c.method === 'DELETE')?.url).toContain(
      '/api/households/mealplans/7'
    );
  });
});

describe('shopping and cookbook writes', () => {
  it('creates a list with just a name', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'create_shopping_list', {
      name: 'Groceries',
    });
    expect(callsOf(spy)[0]).toMatchObject({
      method: 'POST',
      body: { name: 'Groceries' },
    });
  });

  it('deletes a list behind a confirmation', async () => {
    const spy = mockFetch();
    const result = await confirmed(await connect(), 'delete_shopping_list', {
      list_id: TAG_ID,
    });
    expect(result.prompt).toContain('every item on it');
    expect(callsOf(spy).find((c) => c.method === 'DELETE')?.url).toContain(
      `/api/households/shopping/lists/${TAG_ID}`
    );
  });

  it('creates a cookbook with its saved filter', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'create_cookbook', {
      name: 'Desserts',
      description: 'sweet things',
      query_filter: 'tags.name IN ["Dessert"]',
      is_public: true,
    });
    expect(callsOf(spy)[0]!.body).toEqual({
      name: 'Desserts',
      description: 'sweet things',
      public: true,
      queryFilterString: 'tags.name IN ["Dessert"]',
    });
  });

  it('defaults a cookbook to private and unfiltered', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'create_cookbook', { name: 'Desserts' });
    expect(callsOf(spy)[0]!.body).toEqual({
      name: 'Desserts',
      description: '',
      public: false,
    });
  });

  it('deletes a cookbook behind a confirmation and keeps the recipes', async () => {
    const spy = mockFetch();
    const result = await confirmed(await connect(), 'delete_cookbook', {
      cookbook_id: TAG_ID,
    });
    expect(result.prompt).toContain('recipes it matched are kept');
    expect(callsOf(spy).find((c) => c.method === 'DELETE')?.url).toContain(
      `/api/households/cookbooks/${TAG_ID}`
    );
  });
});

describe('engagement writes', () => {
  it('sets only the favourite flag when no rating was given', async () => {
    const spy = mockFetch([GENERIC, { id: 'u-1' }, {}]);
    await callText(await connect(), 'set_recipe_rating', {
      recipe: 'quark-bowl',
      is_favorite: true,
    });
    expect(callsOf(spy)[2]!.body).toEqual({ isFavorite: true });
  });

  it('posts a comment against the resolved recipe UUID', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'add_recipe_comment', {
      recipe: 'quark-bowl',
      text: 'Nice.',
    });
    expect(callsOf(spy)[1]).toMatchObject({
      method: 'POST',
      body: { recipeId: GENERIC.id, text: 'Nice.' },
    });
    expect(callsOf(spy)[1]!.url).toMatch(/\/api\/comments$/);
  });

  it('deletes a comment behind a confirmation', async () => {
    const spy = mockFetch();
    const result = await confirmed(await connect(), 'delete_recipe_comment', {
      comment_id: TAG_ID,
    });
    expect(result.isError).toBe(false);
    expect(callsOf(spy).find((c) => c.method === 'DELETE')?.url).toContain(
      `/api/comments/${TAG_ID}`
    );
  });

  it('passes an explicit timeline timestamp through', async () => {
    const spy = mockFetch([GENERIC, { id: 'u-1' }, {}]);
    await callText(await connect(), 'create_timeline_event', {
      recipe: 'quark-bowl',
      subject: 'Cooked it',
      message: 'Good',
      timestamp: '2026-08-18T19:30:00Z',
    });
    expect(callsOf(spy)[2]!.body).toMatchObject({
      eventMessage: 'Good',
      timestamp: '2026-08-18T19:30:00Z',
    });
  });

  it('duplicates with and without a new name', async () => {
    const spy = mockFetch();
    const client = await connect();
    await callText(client, 'duplicate_recipe', { recipe: 'quark-bowl' });
    await callText(client, 'duplicate_recipe', {
      recipe: 'quark-bowl',
      name: 'Copy',
    });
    const calls = callsOf(spy);
    expect(calls[0]!.url).toContain('/api/recipes/quark-bowl/duplicate');
    expect(calls[0]!.body).toEqual({});
    expect(calls[1]!.body).toEqual({ name: 'Copy' });
  });
});

describe('sharing reads', () => {
  it('filters share tokens by the resolved recipe id', async () => {
    const spy = mockFetch([GENERIC, []]);
    await callText(await connect(), 'list_share_tokens', {
      recipe: 'quark-bowl',
    });
    expect(new URL(callsOf(spy)[1]!.url).searchParams.get('recipe_id')).toBe(
      GENERIC.id
    );
  });

  it('adds the public URL to every token', async () => {
    mockFetch([[{ id: 'tok-1', recipeId: 'r', createdAt: 'c' }]]);
    const { text } = await callText(await connect(), 'list_share_tokens');
    expect(text).toContain(
      '"url": "https://mealie.example.com/shared/recipes/tok-1"'
    );
  });
});

describe('import edge cases', () => {
  it('accepts base64 with embedded whitespace', async () => {
    // Models routinely wrap long base64 across lines.
    const spy = mockFetch(['quark-bowl', GENERIC]);
    const encoded = Buffer.from('fake-jpeg-bytes').toString('base64');
    const { isError } = await callText(
      await connect(),
      'import_recipe_from_image',
      {
        image_base64: `${encoded.slice(0, 4)}\n  ${encoded.slice(4)}`,
        format: 'jpg',
      }
    );
    expect(isError).toBe(false);
    const file = (spy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect((file.get('images') as File).type).toBe('image/jpeg');
  });

  it('rejects base64 of the wrong length', async () => {
    const { isError, text } = await callText(
      await connect(),
      'import_recipe_from_image',
      { image_base64: 'YWJjZA', format: 'png' }
    );
    expect(isError).toBe(true);
    expect(text).toContain('not valid base64');
  });

  it('sends supplied HTML without fetching anything itself', async () => {
    const spy = mockFetch(['quark-bowl', GENERIC]);
    await callText(await connect(), 'import_recipe_from_html_or_json', {
      data: '<html><script type="application/ld+json">{}</script></html>',
    });
    expect(callsOf(spy)[0]!.url).toContain('/api/recipes/create/html-or-json');
    expect(callsOf(spy)[0]!.body).toMatchObject({ data: expect.any(String) });
  });

  it('returns the create response as-is when it is already an object', async () => {
    const spy = mockFetch([GENERIC]);
    const { text } = await callText(
      await connect(),
      'import_recipe_from_html_or_json',
      { data: '{}' }
    );
    expect(callsOf(spy)).toHaveLength(1);
    expect(text).toContain('"slug": "quark-bowl"');
  });
});
