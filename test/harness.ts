import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

/**
 * What every test file here used to keep its own copy of.
 *
 * `connect`, `mockFetch`, `callsOf`, `callText` and `tokenOf` were written out
 * three times, and the copies had already drifted: the one in
 * `tools-writes.test.ts` built a `Config` without `elicitation`, which is not
 * optional any more and only went unnoticed because `tsconfig.json` covers
 * `src` and not `test`.
 */

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: 'https://mealie.example.com',
    token: 'test-token',
    acceptLanguage: undefined,
    insecureTls: false,
    readOnly: false,
    elicitation: true,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

/** The tools a server built with this configuration actually offers. */
export async function toolNames(
  overrides: Partial<Config> = {}
): Promise<string[]> {
  vi.stubGlobal('fetch', vi.fn());
  const client = await connect(overrides);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name).sort();
}

/**
 * One body every projection can read something out of.
 *
 * The shapes take what they know and ignore the rest, so a single mock covers
 * most endpoints.
 */
export const GENERIC = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'quark-bowl',
  name: 'Quark Bowl',
  image: '1',
  items: [],
  listItems: [],
  createdItems: [],
  updatedItems: [],
  recipeIngredient: [],
  recipeInstructions: [],
  tags: [],
  recipeCategory: [],
  tools: [],
  notes: [],
  total: 0,
};

/** How a client that can show a dialog answers it. */
export type ElicitBehaviour = 'accept' | 'decline' | 'cancel';

/**
 * Connects a client to the real server.
 *
 * Without `elicit` the client declares no elicitation capability, which is the
 * case the two-call token exists for and what most tests here drive. With it,
 * the client answers the dialog and `prompts` records what the server put in
 * front of the user.
 */
export async function connect(
  overrides: Partial<Config> = {},
  elicit?: ElicitBehaviour
): Promise<Client & { prompts: string[] }> {
  const server = createServer(testConfig(overrides));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const prompts: string[] = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );
  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message?: string };
      prompts.push(params.message ?? '');
      if (elicit === 'cancel') return { action: 'cancel' };
      if (elicit === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return Object.assign(client, { prompts });
}

export function mockFetch(bodies: unknown[] | unknown = GENERIC) {
  const queue = Array.isArray(bodies) ? [...bodies] : undefined;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const payload = queue === undefined ? bodies : (queue.shift() ?? GENERIC);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

export interface Call {
  url: string;
  method: string;
  body: unknown;
}

export function callsOf(spy: { mock: { calls: unknown[][] } }): Call[] {
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

export async function callText(
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

/** The confirmation token a guarded tool handed back on its first call. */
export function tokenOf(text: string): string {
  const match = /confirm_token="([0-9a-f]+)"/.exec(text);
  if (!match?.[1]) {
    throw new Error(
      `no confirm_token in the result — did the client declare elicitation? ` +
        `Got: ${text.slice(0, 300)}`
    );
  }
  return match[1];
}

/**
 * Runs a guarded tool through both halves of its two-call token.
 *
 * Takes the client rather than living on what `connect` returns, so the
 * signature matches every other repository in this family. Only meaningful on
 * a client that declared no elicitation: with a dialog available the server
 * asks instead of offering a token, which is the point of the dialog.
 */
export async function confirmed(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean; prompt: string }> {
  const first = await callText(client, name, args);
  const second = await callText(client, name, {
    ...args,
    confirm_token: tokenOf(first.text),
  });
  return { ...second, prompt: first.text };
}
