import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { plain } from '../output-schema.js';

import type { MealieApi } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { jsonResult, run } from '../result.js';
import { rec } from '../shape.js';
import { cleanText } from '../text.js';

export function registerInfoTools(server: McpServer, api: MealieApi): void {
  server.registerTool(
    'get_about',
    {
      title: 'About this Mealie instance',
      description:
        'Reports the Mealie version and the identity the API token acts as: user, ' +
        'group, household and the permission flags that decide which write tools ' +
        'will actually succeed. Start here when a call fails with a 403.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      // No untrusted marker: a version string and the permission flags of the
      // account this server authenticates as. The suite pins that on purpose —
      // these are facts the model should act on.
      outputSchema: plain(),
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
        const app = about.status === 'fulfilled' ? rec(about.value) : undefined;
        const user = self.status === 'fulfilled' ? rec(self.value) : undefined;
        // Not passed through untrustedResult: the flags are facts the model
        // needs to act on. The strings beside them are still the instance's
        // — a version, two slugs, a username, the group's name — so they are
        // bounded and cleaned, and only scalars travel: `group` used to be
        // the whole group object with whatever a release puts in it.
        return jsonResult({
          ...(app
            ? {
                version: short(app.version),
                allowSignup: flag(app.allowSignup),
                defaultGroupSlug: short(app.defaultGroupSlug),
                defaultHouseholdSlug: short(app.defaultHouseholdSlug),
                enableOidc: flag(app.enableOidc),
              }
            : { instance_error: reasonMessage(about) }),
          token: user
            ? {
                username: short(user.username),
                admin: flag(user.admin),
                group: short(user.group),
                household: short(user.household),
                // The three flags that gate the write tools in practice.
                canOrganize: flag(user.canOrganize),
                canManage: flag(user.canManage),
                canInvite: flag(user.canInvite),
              }
            : { error: reasonMessage(self) },
        });
      })
  );
}

/** A short display string of the instance's, or nothing. */
function short(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? cleanText(value, 200) : undefined;
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Error text of a rejected half — MealieApiError messages carry no body. */
function reasonMessage(settled: PromiseSettledResult<unknown>): string {
  if (settled.status === 'fulfilled') return '';
  const message =
    settled.reason instanceof Error
      ? settled.reason.message
      : String(settled.reason);
  return cleanText(message, 300);
}
