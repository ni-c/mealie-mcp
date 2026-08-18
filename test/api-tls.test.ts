import { afterEach, describe, expect, it, vi } from 'vitest';

// The insecure-TLS path uses undici's own fetch so the relaxed dispatcher can be
// scoped to this one connection. Mocking the module is the only way to observe
// that from a test: an ESM namespace cannot be spied on in place.
const undiciFetch = vi.fn(
  async () =>
    new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
);

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: undiciFetch };
});

const { MealieApi } = await import('../src/api.js');
import type { Config } from '../src/config.js';

const config: Config = {
  url: 'https://mealie.example.com',
  token: 'test-token',
  acceptLanguage: undefined,
  insecureTls: false,
  readOnly: false,
};

afterEach(() => {
  undiciFetch.mockClear();
  vi.restoreAllMocks();
});

describe('MEALIE_INSECURE_TLS', () => {
  it('scopes the relaxed validation to its own dispatcher', async () => {
    // NODE_TLS_REJECT_UNAUTHORIZED would switch validation off for every
    // connection the process makes, not just the one to Mealie.
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    await new MealieApi({ ...config, insecureTls: true }).get('/api/x');

    expect(globalFetch).not.toHaveBeenCalled();
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const init = undiciFetch.mock.calls[0]![1] as {
      dispatcher?: unknown;
      redirect?: string;
    };
    expect(init.dispatcher).toBeDefined();
    // The other protections still apply on this path.
    expect(init.redirect).toBe('error');
  });

  it('uses the global fetch when TLS validation is left on', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    await new MealieApi(config).get('/api/x');
    expect(undiciFetch).not.toHaveBeenCalled();
  });
});
