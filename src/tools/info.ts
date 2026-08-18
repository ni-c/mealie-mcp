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
        const [about, self] = await Promise.all([
          api.get('/api/app/about'),
          api.get('/api/users/self'),
        ]);
        const app = record(about);
        const user = record(self);
        // Not passed through untrustedResult: every field below is written by the
        // instance operator or by Mealie itself, and the model needs the version
        // and the permission flags as facts it can act on.
        return jsonResult({
          version: app.version,
          allowSignup: app.allowSignup,
          defaultGroupSlug: app.defaultGroupSlug,
          defaultHouseholdSlug: app.defaultHouseholdSlug,
          enableOidc: app.enableOidc,
          token: {
            username: user.username,
            admin: user.admin,
            group: user.group,
            household: user.household,
            // The three flags that gate the write tools in practice.
            canOrganize: user.canOrganize,
            canManage: user.canManage,
            canInvite: user.canInvite,
          },
        });
      })
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}
