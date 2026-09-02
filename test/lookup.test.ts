import { afterEach, describe, expect, it, vi } from 'vitest';

import { MealieApi, MealieApiError } from '../src/api.js';
import type { Config } from '../src/config.js';
import {
  CurrentUser,
  resolveOrganizers,
  resolveRecipe,
} from '../src/lookup.js';

const config: Config = {
  url: 'https://mealie.example.com',
  token: 't',
  acceptLanguage: undefined,
  insecureTls: false,
  readOnly: false,
  elicitation: true,
  allowTools: undefined,
  denyTools: undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Answers each call from a queue, so a sequence of requests can be scripted. */
function scriptFetch(responses: (unknown | MealieApiError)[]) {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const spy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, init) => {
      urls.push(String(url));
      const body = (init as RequestInit | undefined)?.body;
      bodies.push(typeof body === 'string' ? JSON.parse(body) : undefined);
      const next = responses.shift();
      const status = next instanceof MealieApiError ? next.status : 200;
      const payload = next instanceof MealieApiError ? next.body : next;
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
  return { spy, urls, bodies };
}

describe('resolveRecipe', () => {
  it('returns both identifiers for a slug', async () => {
    const { urls } = scriptFetch([{ id: 'r-1', slug: 'quark-bowl' }]);
    await expect(
      resolveRecipe(new MealieApi(config), 'quark-bowl')
    ).resolves.toEqual({ id: 'r-1', slug: 'quark-bowl' });
    expect(urls[0]).toBe('https://mealie.example.com/api/recipes/quark-bowl');
  });

  it('accepts a UUID on the same route', async () => {
    // Verified against Mealie v3.22.0: GET /api/recipes/{…} resolves either.
    const { urls } = scriptFetch([{ id: 'r-1', slug: 'quark-bowl' }]);
    await expect(
      resolveRecipe(
        new MealieApi(config),
        '592cf12b-700c-4e4b-ba98-4ea114ee1e5a'
      )
    ).resolves.toEqual({ id: 'r-1', slug: 'quark-bowl' });
    expect(urls[0]).toContain(
      '/api/recipes/592cf12b-700c-4e4b-ba98-4ea114ee1e5a'
    );
  });

  it('refuses a reference that would escape the path', async () => {
    scriptFetch([{}]);
    await expect(
      resolveRecipe(new MealieApi(config), '../admin/backups')
    ).rejects.toThrow(/invalid recipe reference/);
  });

  it('complains when the response is not a recipe', async () => {
    scriptFetch([{ detail: 'something else' }]);
    await expect(resolveRecipe(new MealieApi(config), 'x')).rejects.toThrow(
      /did not return a recognisable recipe/
    );
  });
});

describe('resolveOrganizers', () => {
  it('returns the full record, because a bare name is rejected with 422', async () => {
    // Mealie's recipe routes require `slug` on a tag or category, so a name has
    // to be turned into the whole record before it can be written.
    const existing = { id: 't-1', name: 'keto', slug: 'keto', groupId: 'g' };
    const { urls } = scriptFetch([{ items: [existing] }]);
    await expect(
      resolveOrganizers(new MealieApi(config), 'tag', ['keto'])
    ).resolves.toEqual([existing]);
    expect(urls[0]).toContain('/api/organizers/tags?search=keto');
  });

  it('matches case-insensitively but never fuzzily', async () => {
    const { bodies } = scriptFetch([
      { items: [{ id: 't-1', name: 'Keto', slug: 'keto' }] },
      { items: [{ id: 't-2', name: 'ketogenic', slug: 'ketogenic' }] },
      { id: 't-3', name: 'keto', slug: 'keto' },
    ]);
    const api = new MealieApi(config);
    await expect(resolveOrganizers(api, 'tag', ['KETO'])).resolves.toEqual([
      { id: 't-1', name: 'Keto', slug: 'keto' },
    ]);
    // "ketogenic" comes back from the search but is not the tag that was asked
    // for, so a new one is created rather than silently filing it there.
    await expect(resolveOrganizers(api, 'tag', ['keto'])).resolves.toEqual([
      { id: 't-3', name: 'keto', slug: 'keto' },
    ]);
    expect(bodies[2]).toEqual({ name: 'keto' });
  });

  it('creates what does not exist yet', async () => {
    const created = { id: 'c-1', name: 'Breakfast', slug: 'breakfast' };
    const { urls, bodies } = scriptFetch([{ items: [] }, created]);
    await expect(
      resolveOrganizers(new MealieApi(config), 'category', ['Breakfast'])
    ).resolves.toEqual([created]);
    expect(urls[1]).toBe(
      'https://mealie.example.com/api/organizers/categories'
    );
    expect(bodies[1]).toEqual({ name: 'Breakfast' });
  });

  it('recovers from a 409 by looking the record up again', async () => {
    // Mealie's slug collision rules are not a case-insensitive name match:
    // "Crème brûlée" and "Creme brulee" collide on the slug but not on the name.
    const existing = { id: 't-9', name: 'Crème brûlée', slug: 'creme-brulee' };
    scriptFetch([
      { items: [] },
      new MealieApiError(409, 'UNIQUE constraint failed', 'POST', '/x'),
      { items: [existing] },
    ]);
    await expect(
      resolveOrganizers(new MealieApi(config), 'tag', ['Crème brûlée'])
    ).resolves.toEqual([existing]);
  });

  it('rethrows a 409 that a second lookup cannot explain', async () => {
    scriptFetch([
      { items: [] },
      new MealieApiError(409, 'conflict', 'POST', '/x'),
      { items: [] },
    ]);
    await expect(
      resolveOrganizers(new MealieApi(config), 'tag', ['x'])
    ).rejects.toThrow(MealieApiError);
  });

  it('rethrows any other error immediately', async () => {
    scriptFetch([
      { items: [] },
      new MealieApiError(403, 'forbidden', 'POST', '/x'),
    ]);
    await expect(
      resolveOrganizers(new MealieApi(config), 'tag', ['x'])
    ).rejects.toMatchObject({ status: 403 });
  });

  it('handles a bare-array search response', async () => {
    const existing = { id: 't-1', name: 'keto', slug: 'keto' };
    scriptFetch([[existing]]);
    await expect(
      resolveOrganizers(new MealieApi(config), 'tag', ['keto'])
    ).resolves.toEqual([existing]);
  });

  it('resolves an empty list without any request', async () => {
    const { spy } = scriptFetch([]);
    await expect(
      resolveOrganizers(new MealieApi(config), 'tag', [])
    ).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('CurrentUser', () => {
  it('fetches the id once and reuses it', async () => {
    const { spy } = scriptFetch([{ id: 'u-1', username: 'cook' }]);
    const user = new CurrentUser(new MealieApi(config));
    await expect(user.id()).resolves.toBe('u-1');
    await expect(user.id()).resolves.toBe('u-1');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent callers', async () => {
    const { spy } = scriptFetch([{ id: 'u-1' }]);
    const user = new CurrentUser(new MealieApi(config));
    await Promise.all([user.id(), user.id(), user.id()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not memoise a failure', async () => {
    const { spy } = scriptFetch([
      new MealieApiError(503, 'down', 'GET', '/api/users/self'),
      { id: 'u-1' },
    ]);
    const user = new CurrentUser(new MealieApi(config));
    await expect(user.id()).rejects.toThrow(MealieApiError);
    await expect(user.id()).resolves.toBe('u-1');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('complains when the response carries no id', async () => {
    scriptFetch([{ username: 'cook' }]);
    await expect(new CurrentUser(new MealieApi(config)).id()).rejects.toThrow(
      /Could not determine the current user/
    );
  });
});
