import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * Brings the throwaway Mealie from empty to usable, without a browser.
 *
 * The curl recipe this replaces lived in CONTRIBUTING.md, where it was seven
 * commands to copy by hand and no way to know it had gone stale. Executed code
 * cannot go stale quietly.
 *
 * Two things about Mealie that cost a session each and are not in its
 * documentation:
 *
 *  - `DEFAULT_EMAIL` and `DEFAULT_PASSWORD` are **ignored** on a fresh
 *    instance. The seeded admin is always `changeme@example.com` / `MyPassword`.
 *  - `POST /api/admin/users` wants `group` and `household` as **names**, not
 *    UUIDs. Sending ids is accepted and produces a user who cannot see
 *    anything.
 */

const ADMIN_EMAIL = 'changeme@example.com';
const ADMIN_PASSWORD = 'MyPassword';
/** A non-admin, mirroring a sensible deployment rather than a root token. */
const COOK_EMAIL = 'cook@example.com';
const COOK_PASSWORD = 'MyPassword';

export interface Sandbox {
  url: string;
  /** An API token belonging to the non-admin user. */
  token: string;
}

async function login(url: string, username: string, password: string) {
  const response = await fetch(`${url}/api/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `login as ${username} failed: HTTP ${response.status} — ` +
        `${(await response.text()).slice(0, 200)}`
    );
  }
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

async function post(
  url: string,
  path: string,
  token: string,
  payload: object
): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${path} failed: HTTP ${response.status} — ` +
        `${(await response.text()).slice(0, 300)}`
    );
  }
  return response.json();
}

export async function bootstrap(
  url = 'http://127.0.0.1:9930'
): Promise<Sandbox> {
  assertLoopback(url);
  await waitForHttp(`${url}/api/app/about`, {
    timeoutSeconds: 180,
    ready: (response) => response.ok,
  });

  const admin = await login(url, ADMIN_EMAIL, ADMIN_PASSWORD);

  await post(url, '/api/admin/users', admin, {
    username: 'cook',
    fullName: 'Cook',
    email: COOK_EMAIL,
    password: COOK_PASSWORD,
    admin: false,
    // Names, not ids. See the note at the top of this file.
    group: 'Home',
    household: 'Family',
    canOrganize: true,
    canManage: false,
    canInvite: false,
    advanced: true,
  });

  const cook = await login(url, COOK_EMAIL, COOK_PASSWORD);
  const minted = (await post(url, '/api/users/api-tokens', cook, {
    name: 'mealie-mcp-integration',
  })) as { token?: string };
  if (minted.token === undefined) {
    throw new Error('Mealie minted no API token');
  }

  return { url, token: minted.token };
}
