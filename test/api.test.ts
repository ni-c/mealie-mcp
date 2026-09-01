import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertPathSegment,
  MealieApi,
  MealieApiError,
  query,
} from '../src/api.js';
import type { Config } from '../src/config.js';

const config: Config = {
  url: 'https://mealie.example.com',
  token: 'test-token',
  acceptLanguage: undefined,
  insecureTls: false,
  readOnly: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function respondWith(response: Response) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Promise.resolve(response));
}

function initOf(spy: { mock: { calls: unknown[][] } }): RequestInit {
  return (spy.mock.calls[0]?.[1] ?? {}) as RequestInit;
}

describe('assertPathSegment', () => {
  it('accepts slugs and UUIDs', () => {
    expect(assertPathSegment('quark-bowl', 'recipe')).toBe('quark-bowl');
    expect(
      assertPathSegment('592cf12b-700c-4e4b-ba98-4ea114ee1e5a', 'recipe')
    ).toBe('592cf12b-700c-4e4b-ba98-4ea114ee1e5a');
  });

  it('rejects path traversal and separators', () => {
    for (const bad of ['../admin', 'a/b', '..', '.', 'a b', 'a%2fb', '']) {
      expect(() => assertPathSegment(bad, 'recipe')).toThrow(/invalid recipe/);
    }
  });
});

describe('query', () => {
  it('omits undefined values', () => {
    expect(query({ a: 1, b: undefined, c: 'x' })).toBe('?a=1&c=x');
  });

  it('returns an empty string when nothing is set', () => {
    expect(query({ a: undefined })).toBe('');
  });

  it('repeats a key per array entry, as FastAPI expects', () => {
    // A comma-joined value would arrive as one filter named "keto,vegetarian"
    // and silently match nothing.
    const encoded = query({ tags: ['keto', 'vegetarian'], page: 1 });
    expect(encoded).toBe('?tags=keto&tags=vegetarian&page=1');
    const params = new URL(`https://x${encoded}`).searchParams;
    expect(params.getAll('tags')).toEqual(['keto', 'vegetarian']);
  });

  it('drops an empty array', () => {
    expect(query({ tags: [] })).toBe('');
  });

  it('percent-encodes values that carry query syntax', () => {
    const encoded = query({ queryFilter: 'recipe_id="a&b"' });
    expect(new URL(`https://x${encoded}`).searchParams.get('queryFilter')).toBe(
      'recipe_id="a&b"'
    );
  });

  it('serialises booleans and numbers', () => {
    expect(query({ a: true, b: false, c: 0 })).toBe('?a=true&b=false&c=0');
  });
});

describe('MealieApi.request', () => {
  it('sends the bearer token and refuses redirects', async () => {
    const spy = respondWith(jsonResponse({ ok: true }));
    await new MealieApi(config).get('/api/app/about');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mealie.example.com/api/app/about');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
    // A redirect would resend the token to whatever host the upstream names.
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });

  it('omits accept-language unless configured', async () => {
    const spy = respondWith(jsonResponse({}));
    await new MealieApi(config).get('/api/app/about');
    expect(
      (initOf(spy).headers as Record<string, string>)['Accept-Language']
    ).toBeUndefined();
  });

  it('sends accept-language when configured', async () => {
    const spy = respondWith(jsonResponse({}));
    await new MealieApi({ ...config, acceptLanguage: 'de-DE' }).get('/api/x');
    expect(
      (initOf(spy).headers as Record<string, string>)['Accept-Language']
    ).toBe('de-DE');
  });

  it('serialises a JSON body and sets the content type', async () => {
    const spy = respondWith(jsonResponse({}));
    await new MealieApi(config).post('/api/recipes', { name: 'X' });
    const init = initOf(spy);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"X"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json'
    );
  });

  it('passes FormData through without a content type', async () => {
    // The runtime has to generate the multipart boundary; setting the header
    // ourselves would produce a body the server cannot parse.
    const spy = respondWith(jsonResponse({}));
    const form = new FormData();
    form.append('images', new Blob([new Uint8Array([1, 2])]), 'a.png');
    await new MealieApi(config).post('/api/recipes/create/image', form);
    const init = initOf(spy);
    expect(init.body).toBeInstanceOf(FormData);
    expect(
      (init.headers as Record<string, string>)['Content-Type']
    ).toBeUndefined();
  });

  it('sends no body at all when none was given', async () => {
    const spy = respondWith(jsonResponse({}));
    await new MealieApi(config).delete('/api/comments/x');
    expect(initOf(spy).body).toBeUndefined();
  });

  it('throws MealieApiError with the status and body', async () => {
    respondWith(jsonResponse({ detail: 'nope' }, 404));
    await expect(new MealieApi(config).get('/api/recipes/x')).rejects.toThrow(
      MealieApiError
    );
    respondWith(jsonResponse({ detail: 'nope' }, 422));
    await expect(
      new MealieApi(config).get('/api/recipes/x')
    ).rejects.toMatchObject({ status: 422, body: '{"detail":"nope"}' });
  });

  it('returns text for a non-JSON response', async () => {
    respondWith(new Response('plain', { status: 200 }));
    await expect(new MealieApi(config).get('/api/x')).resolves.toBe('plain');
  });

  it('returns text when the JSON is malformed', async () => {
    respondWith(
      new Response('{not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(new MealieApi(config).get('/api/x')).resolves.toBe(
      '{not json'
    );
  });

  it('parses a bare JSON string, which is how the create routes answer', async () => {
    respondWith(jsonResponse('quark-bowl'));
    await expect(new MealieApi(config).post('/api/recipes', {})).resolves.toBe(
      'quark-bowl'
    );
  });

  it('demands credentials at call time, not at construction', async () => {
    const api = new MealieApi({ ...config, token: undefined });
    await expect(api.get('/api/x')).rejects.toThrow(/MEALIE_API_TOKEN/);
  });

  it('refuses a response whose content-length exceeds the cap', async () => {
    respondWith(
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(9 * 1024 * 1024),
        },
      })
    );
    await expect(new MealieApi(config).get('/api/x')).rejects.toThrow(
      /more than the 8388608 byte limit/
    );
  });

  it('refuses an oversized streamed body even without content-length', async () => {
    // content-length is upstream-controlled and absent on chunked responses, so
    // the streaming path has to enforce the limit again.
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 9; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    respondWith(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(new MealieApi(config).get('/api/x')).rejects.toThrow(
      /8388608 byte limit/
    );
  });

  it('falls back to text() for a response without a stream', async () => {
    // Response-like stubs in other test suites have no body stream; the
    // content-length check still applies on that path.
    respondWith({
      headers: {
        get: (n: string) => (n === 'content-type' ? 'application/json' : null),
      },
      body: null,
      ok: true,
      status: 200,
      text: async () => '{"a":1}',
    } as unknown as Response);
    await expect(new MealieApi(config).get('/api/x')).resolves.toEqual({
      a: 1,
    });
  });

  it('enforces the cap on the text() fallback too', async () => {
    respondWith({
      headers: { get: () => null },
      body: null,
      ok: true,
      status: 200,
      text: async () => 'x'.repeat(9 * 1024 * 1024),
    } as unknown as Response);
    await expect(new MealieApi(config).get('/api/x')).rejects.toThrow(
      /8388608 byte limit/
    );
  });

  it('exposes every verb the tools need', async () => {
    const spy = respondWith(jsonResponse({}));
    const api = new MealieApi(config);
    await api.get('/a');
    await api.post('/a');
    await api.put('/a', {});
    await api.patch('/a', {});
    await api.delete('/a');
    expect(
      spy.mock.calls.map(([, init]) => (init as RequestInit).method)
    ).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });
});
