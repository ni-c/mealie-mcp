import { afterEach, describe, expect, it, vi } from 'vitest';

import { callsOf, callText, connect, GENERIC, mockFetch } from './harness.js';

/**
 * `search_recipes` against the way Mealie really answers.
 *
 * Every claim below was measured against `ghcr.io/mealie-recipes/mealie:v3.22.0`
 * with three recipes, one of them tagged "Weeknight Dinner":
 *
 *   GET /api/recipes?tags=Weeknight%20Dinner  -> all three
 *   GET /api/recipes?tags=weeknight-dinner    -> the one
 *   GET /api/recipes?tags=weeknight-dinnerrr  -> all three
 *   GET /api/recipes?foods=carrot             -> HTTP 500
 *   GET /api/recipes?orderBy=random           -> HTTP 422
 *   GET /api/recipes?cookbook=all-things&tags=weeknight-dinner -> all three
 *
 * The first, third and last of those are the dangerous shape: a filter Mealie
 * cannot use is not an error, it is *absent*, and the answer is the whole
 * collection with nothing to say it was not narrowed.
 */

const TAG = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Weeknight Dinner',
  slug: 'weeknight-dinner',
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fetch stub that can answer some paths with 404. */
function mockFetchWith(
  handler: (url: string) => { status: number; body: unknown }
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const { status, body } = handler(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

describe('organizer filters are resolved before the search runs', () => {
  it('turns a tag name into the id Mealie actually filters on', async () => {
    const spy = mockFetch([{ items: [TAG] }, GENERIC]);
    const { isError } = await callText(await connect(), 'search_recipes', {
      tags: ['Weeknight Dinner'],
    });
    expect(isError).toBe(false);
    const calls = callsOf(spy);
    expect(calls[0]!.url).toContain('/api/organizers/tags?search=');
    // Not the name. Mealie looks a non-UUID up as a slug, finds nothing for a
    // name, and then drops the filter entirely.
    expect(new URL(calls[1]!.url).searchParams.getAll('tags')).toEqual([
      TAG.id,
    ]);
  });

  it('looks a slug up through the slug route, not the name search', async () => {
    // Mealie folds accents into the slug but searches on the name, so
    // `?search=creme-brulee` finds nothing for a tag called "Crème Brûlée"
    // whose slug is exactly that. Slugs worked before any of this existed and
    // have to keep working.
    const spy = mockFetch([TAG, GENERIC]);
    await callText(await connect(), 'search_recipes', {
      tags: ['weeknight-dinner'],
    });
    const calls = callsOf(spy);
    expect(calls[0]!.url).toContain(
      '/api/organizers/tags/slug/weeknight-dinner'
    );
    expect(new URL(calls[1]!.url).searchParams.getAll('tags')).toEqual([
      TAG.id,
    ]);
  });

  it.each([404, 500])(
    'falls back to the name search when the slug route answers %i',
    async (status) => {
      // Mealie answers "no such slug" with a 404 on the category route and with
      // a 500 on the tag and tool routes — measured on v3.22.0. Reading only
      // the 404 turned a mistyped tag into a bare "HTTP 500" that named neither
      // the tag nor what to do about it, which the integration suite caught.
      const spy = mockFetchWith((url) =>
        url.includes('/slug/')
          ? { status, body: { detail: 'Not found' } }
          : url.includes('/api/organizers/')
            ? { status: 200, body: { items: [{ ...TAG, name: '30-minute' }] } }
            : { status: 200, body: GENERIC }
      );
      const { isError } = await callText(await connect(), 'search_recipes', {
        tags: ['30-minute'],
      });
      expect(isError).toBe(false);
      expect(
        new URL(callsOf(spy).at(-1)!.url).searchParams.getAll('tags')
      ).toEqual([TAG.id]);
    }
  );

  it('reports the failure when the name search fails too', async () => {
    // Reading a 500 as "not here" is only safe because a second request
    // follows. A Mealie that is really broken has to say so rather than be
    // reported as "no such tag".
    const spy = mockFetchWith(() => ({
      status: 500,
      body: { detail: 'Internal Server Error' },
    }));
    const { text, isError } = await callText(
      await connect(),
      'search_recipes',
      { tags: ['30-minute'] }
    );
    expect(isError).toBe(true);
    expect(text).toContain('500');
    expect(
      callsOf(spy).some((call) => call.url.includes('/api/recipes')),
      'searched anyway'
    ).toBe(false);
  });

  it('passes a UUID straight through without a lookup', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'search_recipes', { tags: [TAG.id] });
    const calls = callsOf(spy);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.getAll('tags')).toEqual([
      TAG.id,
    ]);
  });

  it('refuses a filter it cannot resolve instead of searching without it', async () => {
    // The whole point. A typo used to come back as the first 25 recipes of the
    // collection, presented as the answer to a narrowed question.
    const spy = mockFetchWith((url) =>
      url.includes('/slug/')
        ? { status: 404, body: { detail: 'Not found' } }
        : { status: 200, body: { items: [] } }
    );
    const { text, isError } = await callText(
      await connect(),
      'search_recipes',
      { tags: ['weeknight-dinnerrr'] }
    );
    expect(isError).toBe(true);
    expect(text).toContain('weeknight-dinnerrr');
    expect(text).toContain('list_organizers');
    expect(
      callsOf(spy).some((call) => call.url.includes('/api/recipes')),
      'searched anyway'
    ).toBe(false);
  });

  it('resolves categories and tools through their own paths', async () => {
    const spy = mockFetch([TAG, TAG, GENERIC]);
    await callText(await connect(), 'search_recipes', {
      categories: ['weeknight-dinner'],
      tools: ['weeknight-dinner'],
    });
    const urls = callsOf(spy).map((call) => call.url);
    expect(urls[0]).toContain('/api/organizers/categories/slug/');
    expect(urls[1]).toContain('/api/organizers/tools/slug/');
  });

  it('never sends a name into a path segment', async () => {
    // A name is not a slug and must not be built into a URL path. Only the
    // search parameter may carry it.
    const spy = mockFetch([{ items: [TAG] }, GENERIC]);
    await callText(await connect(), 'search_recipes', {
      tags: ['../../etc/passwd'],
    });
    for (const call of callsOf(spy)) {
      expect(new URL(call.url).pathname).not.toContain('..');
    }
  });
});

describe('filters Mealie cannot combine or resolve', () => {
  it('rejects a cookbook combined with an organizer filter', async () => {
    // `_build_recipe_filter` returns the cookbook's own filter and returns
    // early, so the tags never reach the query. The tool description promises
    // AND, and this is what keeps the promise honest.
    const spy = mockFetch();
    const { text, isError } = await callText(
      await connect(),
      'search_recipes',
      { cookbook: 'desserts', tags: ['vegan'] }
    );
    expect(isError).toBe(true);
    expect(text).toContain('cookbook cannot be combined with tags');
    expect(text).toContain('get_cookbook');
    expect(spy).not.toHaveBeenCalled();
  });

  it('takes a cookbook on its own', async () => {
    const spy = mockFetch();
    const { isError } = await callText(await connect(), 'search_recipes', {
      cookbook: 'desserts',
    });
    expect(isError).toBe(false);
    expect(new URL(callsOf(spy)[0]!.url).searchParams.get('cookbook')).toBe(
      'desserts'
    );
  });

  it('takes only UUIDs for foods, like suggest_recipes always has', async () => {
    // Mealie resolves nothing here: the value goes straight into
    // `RecipeIngredientModel.food_id == food` and a non-UUID comes back as an
    // HTTP 500 from the GUID type decorator.
    const spy = mockFetch();
    const { isError } = await callText(await connect(), 'search_recipes', {
      foods: ['carrot'],
    });
    expect(isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('order_by: random', () => {
  it('sends the pagination seed Mealie insists on', async () => {
    // Without it: HTTP 422, `paginationSeed is required when orderBy is
    // random`. The tool takes no seed, so offering `random` without generating
    // one was offering an option that could only fail.
    const spy = mockFetch();
    const { isError } = await callText(await connect(), 'search_recipes', {
      order_by: 'random',
    });
    expect(isError).toBe(false);
    const url = new URL(callsOf(spy)[0]!.url);
    expect(url.searchParams.get('orderBy')).toBe('random');
    expect(url.searchParams.get('paginationSeed')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('draws a new seed each time', async () => {
    const spy = mockFetch();
    const client = await connect();
    await callText(client, 'search_recipes', { order_by: 'random' });
    await callText(client, 'search_recipes', { order_by: 'random' });
    const seeds = callsOf(spy).map((call) =>
      new URL(call.url).searchParams.get('paginationSeed')
    );
    expect(seeds[0]).not.toBe(seeds[1]);
  });

  it('sends no seed for any other order', async () => {
    const spy = mockFetch();
    await callText(await connect(), 'search_recipes', { order_by: 'name' });
    expect(
      new URL(callsOf(spy)[0]!.url).searchParams.has('paginationSeed')
    ).toBe(false);
  });
});

describe('source_url', () => {
  it('refuses a scheme Mealie would hand back to every reader', async () => {
    // The only URL-shaped argument in the server that had no scheme check.
    // Mealie does not validate `org_url` either, and `recipeDetail` returns it
    // to whoever reads the recipe next.
    const spy = mockFetch();
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>',
      'not a url at all',
    ]) {
      const { isError } = await callText(await connect(), 'update_recipe', {
        recipe: 'quark-bowl',
        source_url: url,
      });
      expect(isError, url).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('still takes an ordinary http address', async () => {
    const spy = mockFetch();
    const { isError } = await callText(await connect(), 'create_recipe', {
      name: 'Quark Bowl',
      source_url: 'https://example.com/quark-bowl',
    });
    expect(isError).toBe(false);
    expect(spy).toHaveBeenCalled();
  });
});
