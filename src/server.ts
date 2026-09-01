import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { buildToolFilter, installToolFilter } from 'mcp-tool-allowlist';

import { ALL_TOOLS, ESSENTIAL_TOOLS, READ_TOOLS } from './tools/catalogue.js';
import {
  registerCookbookReadTools,
  registerCookbookWriteTools,
} from './tools/cookbooks.js';
import {
  registerFoodReadTools,
  registerFoodWriteTools,
} from './tools/foods.js';
import {
  registerMealplanReadTools,
  registerMealplanWriteTools,
} from './tools/mealplans.js';
import {
  registerOrganizerReadTools,
  registerOrganizerWriteTools,
} from './tools/organizers.js';
import {
  registerRecipeReadTools,
  registerRecipeWriteTools,
} from './tools/recipes.js';
import {
  registerSharingReadTools,
  registerSharingWriteTools,
} from './tools/sharing.js';
import {
  registerShoppingReadTools,
  registerShoppingWriteTools,
} from './tools/shopping.js';

import { MealieApi } from './api.js';
import type { Config } from './config.js';
import { ConfirmationStore, createApproval } from 'mcp-approval';
import { CurrentUser } from './lookup.js';
import { registerEngagementWriteTools } from './tools/engagement.js';
import {
  registerImportReadTools,
  registerImportTools,
} from './tools/imports.js';
import { registerInfoTools } from './tools/info.js';

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export function createServer(config: Config): McpServer {
  // Before anything is built: an unusable tool list should fail on the
  // way in, not leave a server running with tools quietly missing.
  const filter = buildToolFilter({
    allowTools: config.allowTools,
    denyTools: config.denyTools,
    catalogue: {
      all: ALL_TOOLS,
      essential: ESSENTIAL_TOOLS,
      ungated: READ_TOOLS,
    },
    names: {
      allow: 'MEALIE_ALLOW_TOOLS',
      deny: 'MEALIE_DENY_TOOLS',
      server: 'mealie-mcp',
    },
    gate: {
      closed: config.readOnly,
      variable: 'MEALIE_READ_ONLY',
      noun: 'read-only mode',
    },
  });

  const api = new MealieApi(config);
  const confirmations = new ConfirmationStore();
  // One approver per server: it holds the key that seals the request state
  // carried out through the client and back.
  const approval = createApproval({ server: 'mealie-mcp' });
  const currentUser = new CurrentUser(api);

  const server = new McpServer({
    name: 'mealie-mcp',
    version: packageVersion(),
  });

  // Wraps server.registerTool, so it has to sit before the first
  // register call and does not care how they are organised.
  installToolFilter(server, filter);

  registerInfoTools(server, api);
  registerRecipeReadTools(server, api, config);
  registerOrganizerReadTools(server, api);
  registerFoodReadTools(server, api);
  registerMealplanReadTools(server, api);
  registerShoppingReadTools(server, api);
  registerCookbookReadTools(server, api);
  registerSharingReadTools(server, api, config);
  // preview_recipe_url fetches a URL and reports what Mealie would extract,
  // saving nothing — a read tool, and annotated as one. It used to sit with
  // the import tools and disappear under MEALIE_READ_ONLY, which made the
  // catalogue and the annotation contradict each other. The reason it was
  // gated is real but belongs elsewhere: it makes Mealie fetch a
  // caller-supplied URL, and that is refused for internal addresses by
  // assertFetchableUrl in schema.ts, on every call, read-only or not.
  registerImportReadTools(server, api);

  // Read-only mode does not register the write tools at all. Rejecting them at
  // call time would still advertise capabilities the server refuses to provide.
  if (!config.readOnly) {
    registerRecipeWriteTools(server, api, config, confirmations, approval);
    registerImportTools(server, api, config);
    registerOrganizerWriteTools(server, api, confirmations, approval);
    registerFoodWriteTools(server, api, confirmations, approval);
    registerMealplanWriteTools(server, api, confirmations, approval);
    registerShoppingWriteTools(server, api, confirmations, approval);
    registerCookbookWriteTools(server, api, confirmations, approval);
    registerSharingWriteTools(server, api, config, confirmations, approval);
    registerEngagementWriteTools(
      server,
      api,
      currentUser,
      confirmations,
      approval
    );
  }

  return server;
}
