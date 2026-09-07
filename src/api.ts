import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';

/** Ample for anything that is a database lookup, which is most of the API. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * For the handful of calls that hand Mealie real work: scraping a recipe URL
 * runs a headless fetch plus parsing, importing from an image calls out to an
 * LLM provider, and adding a recipe to a shopping list merges every ingredient.
 * All of these regularly need tens of seconds on a small self-hosted instance —
 * but a hung upstream should not stall a plain `list_units` for a minute, so
 * the long timeout is opted into per call rather than applied uniformly.
 */
export const LONG_TIMEOUT_MS = 60_000;

/**
 * Hard cap on how much of a response body is read into memory.
 *
 * The result budget in `result.ts` only applies once the body has been buffered,
 * so it does not protect against the body itself. A misconfigured `MEALIE_URL`
 * pointing at something that streams endlessly, or a reverse proxy emitting a
 * huge error page, would otherwise grow the process until it is killed. 8 MB is
 * far above any legitimate response — the largest one this server asks for is a
 * page of 100 recipe summaries.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * How much of an *error* body is kept. An error body is quoted into a result,
 * cut to two thousand characters there; reading more than this of it buys
 * nothing, and a reverse proxy's login page is megabytes.
 */
const MAX_ERROR_BYTES = 64 * 1024;

/** The parts of a response the body readers need, typed loosely on purpose:
 * undici's `Response` and the global one are not assignable to each other. */
interface BodyLike {
  headers: { get(name: string): string | null };
  body: unknown;
  text(): Promise<string>;
}

/**
 * Reads a response body, refusing anything past {@link MAX_RESPONSE_BYTES}.
 *
 * `content-length` is checked first because it lets an oversized response be
 * rejected without transferring it, but it is absent on chunked responses and is
 * upstream-controlled either way, so the streaming path enforces the limit again.
 */
async function readCappedText(response: BodyLike): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Mealie returned ${declared} bytes, more than the ${MAX_RESPONSE_BYTES} byte limit this server will read.`
    );
  }

  const body = response.body as AsyncIterable<Uint8Array> | null | undefined;
  // Test stubs of fetch commonly return a Response-like object without a stream.
  // Falling back to text() there keeps them working; the content-length check
  // above still applies.
  if (!isAsyncIterable(body)) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Mealie returned more than the ${MAX_RESPONSE_BYTES} byte limit this server will read.`
      );
    }
    return text;
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Mealie returned more than the ${MAX_RESPONSE_BYTES} byte limit this server will read.`
      );
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Reads the start of an error body and never throws over its size.
 *
 * The status is the answer; the body is a hint. A `401` behind a proxy that
 * answers with a two-megabyte login page used to surface as "more than the
 * byte limit" — the size, not the status, and no word about credentials.
 */
async function readErrorText(response: BodyLike): Promise<string> {
  const body = response.body as AsyncIterable<Uint8Array> | null | undefined;
  if (!isAsyncIterable(body)) {
    const text = await response.text();
    return text.length > MAX_ERROR_BYTES
      ? text.slice(0, MAX_ERROR_BYTES)
      : text;
  }
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for await (const chunk of body) {
    const room = MAX_ERROR_BYTES - total;
    const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    total += part.byteLength;
    text += decoder.decode(part, { stream: true });
    // Leaving the loop early cancels the stream through the iterator's
    // `return()`; the rest of the page is never transferred.
    if (total >= MAX_ERROR_BYTES) break;
  }
  return text + decoder.decode();
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
      'function'
  );
}

/**
 * Refuses a header value the runtime would refuse — before the runtime does.
 *
 * undici's refusal quotes the whole value in its message, and for the
 * `Authorization` header the whole value is the token. Checking here means the
 * error can name the header and nothing else.
 */
function assertHeaderValue(name: string, value: string): string {
  // Written out per code unit rather than as a character class, so no escape
  // in this file can be turned into a raw byte by an editing tool.
  let ok = value.length === 0 || (value[0] !== ' ' && value.at(-1) !== ' ');
  for (let index = 0; ok && index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    ok =
      code === 0x09 ||
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0x80 && code <= 0xff);
  }
  if (!ok) {
    throw new Error(
      `the ${name} header cannot be built from the configured value: it carries a character a header cannot hold`
    );
  }
  return value;
}

export class MealieApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    path: string
  ) {
    super(`Mealie API ${method} ${path} failed with HTTP ${status}`);
    this.name = 'MealieApiError';
  }
}

/** Minimal client for the Mealie REST API (verified against Mealie v3.22.0). */
export class MealieApi {
  private readonly config: Config;
  private readonly baseUrl: string;
  /**
   * Only set when MEALIE_INSECURE_TLS is enabled. Scopes the relaxed certificate
   * validation to requests against the configured host instead of disabling it
   * process-wide via NODE_TLS_REJECT_UNAUTHORIZED.
   */
  private readonly insecureDispatcher?: Agent;

  constructor(config: Config) {
    this.config = config;
    this.baseUrl = config.url ?? '';
    if (config.insecureTls) {
      this.insecureDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  /**
   * Performs a request. `body` is sent as JSON; a FormData instance is passed
   * through untouched so the runtime sets its own multipart boundary.
   */
  async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    // The credentials are only required here, not at startup, so the server can
    // still be started and introspected without them.
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) {
      throw new Error(missingConfigMessage(missing));
    }

    const headers: Record<string, string> = {
      Authorization: assertHeaderValue(
        'Authorization',
        `Bearer ${this.config.token ?? ''}`
      ),
      Accept: 'application/json',
    };
    if (this.config.acceptLanguage) {
      headers['Accept-Language'] = assertHeaderValue(
        'Accept-Language',
        this.config.acceptLanguage
      );
    }
    const init: RequestInit = {
      method,
      headers,
      // Never follow a redirect: it would resend the Authorization header to
      // whatever host the upstream points at. Mealie is commonly put behind a
      // reverse proxy that redirects http -> https, and a mistyped MEALIE_URL
      // would leak the token that way.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const url = `${this.baseUrl}${path}`;
    // The insecure dispatcher requires undici's own fetch; the default path uses
    // the (stubbable) global fetch so tests can intercept it.
    const response = this.insecureDispatcher
      ? await undiciFetch(url, {
          ...init,
          dispatcher: this.insecureDispatcher,
        } as UndiciRequestInit)
      : await fetch(url, init);

    // The status first, then the body under a ceiling that fits the status:
    // an error body is a hint and is cut, a success body is the answer and is
    // refused past the cap. Read the other way round, an oversized error page
    // hid the status it came with.
    if (!response.ok) {
      throw new MealieApiError(
        response.status,
        await readErrorText(response),
        method,
        path
      );
    }
    const text = await readCappedText(response);

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
    return text;
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  post(path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    return this.request('POST', path, body, timeoutMs);
  }

  put(path: string, body?: unknown): Promise<unknown> {
    return this.request('PUT', path, body);
  }

  patch(path: string, body?: unknown): Promise<unknown> {
    return this.request('PATCH', path, body);
  }

  delete(path: string, body?: unknown): Promise<unknown> {
    return this.request('DELETE', path, body);
  }
}

/**
 * Guards a value that ends up in a URL path.
 *
 * Mealie addresses recipes by slug and everything else by UUID, so a path
 * segment is always `[a-z0-9-]`-shaped. Path traversal here would let a caller
 * reach a different resource — or, with enough `..`, a different API entirely.
 */
export function assertPathSegment(value: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(
      `invalid ${what}: only letters, digits, dot, underscore and hyphen are allowed`
    );
  }
  return value;
}

/** A query parameter value; arrays become repeated keys, as FastAPI expects. */
export type QueryValue =
  string | number | boolean | ReadonlyArray<string> | undefined;

/**
 * Builds a query string from defined values only.
 *
 * Mealie's list endpoints take their multi-valued filters (`tags`, `categories`,
 * `foods`, `tools`) as repeated keys rather than as a comma-separated list, so
 * arrays are appended one entry at a time.
 */
export function query(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) search.append(key, entry);
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}
