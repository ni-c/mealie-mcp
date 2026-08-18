import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { MealieApi } from '../api.js';
import { jsonResult, run } from '../result.js';

export function registerInfoTools(server: McpServer, api: MealieApi): void {
  server.registerTool(
    'get_about',
    {
      title: 'About this Mealie instance',
      description:
        'Reports the Mealie version and the identity the API token acts as: user, ' +
        'group, household and the permission flags that decide which write tools ' +
        'will actually succeed. Start here when a call fails with a 403.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        // This tool's stated purpose is diagnosing a 403 — so one failing half
        // must not take the other half's answer with it. Both halves failing is
        // a plain error (typically missing credentials) and reported as one.
        const [about, self] = await Promise.allSettled([
          api.get('/api/app/about'),
          api.get('/api/users/self'),
        ]);
        if (about.status === 'rejected' && self.status === 'rejected') {
          throw about.reason;
        }
        const app =
          about.status === 'fulfilled' ? record(about.value) : undefined;
        const user =
          self.status === 'fulfilled' ? record(self.value) : undefined;
        // Not passed through untrustedResult: every field below is written by the
        // instance operator or by Mealie itself, and the model needs the version
        // and the permission flags as facts it can act on.
        return jsonResult({
          ...(app
            ? {
                version: app.version,
                allowSignup: app.allowSignup,
                defaultGroupSlug: app.defaultGroupSlug,
                defaultHouseholdSlug: app.defaultHouseholdSlug,
                enableOidc: app.enableOidc,
              }
            : { instance_error: reasonMessage(about) }),
          token: user
            ? {
                username: user.username,
                admin: user.admin,
                group: user.group,
                household: user.household,
                // The three flags that gate the write tools in practice.
                canOrganize: user.canOrganize,
                canManage: user.canManage,
                canInvite: user.canInvite,
              }
            : { error: reasonMessage(self) },
        });
      })
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/** Error text of a rejected half — MealieApiError messages carry no body. */
function reasonMessage(settled: PromiseSettledResult<unknown>): string {
  if (settled.status === 'fulfilled') return '';
  return settled.reason instanceof Error
    ? settled.reason.message
    : String(settled.reason);
}
