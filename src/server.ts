import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { MealieApi } from './api.js';
import { buildToolFilter, installToolFilter } from './tool-filter.js';
import type { Config } from './config.js';
import { ConfirmationStore } from './confirm.js';
import { CurrentUser } from './lookup.js';
import {
  registerCookbookReadTools,
  registerCookbookWriteTools,
} from './tools/cookbooks.js';
import { registerEngagementWriteTools } from './tools/engagement.js';
import {
  registerFoodReadTools,
  registerFoodWriteTools,
} from './tools/foods.js';
import { registerImportTools } from './tools/imports.js';
import { registerInfoTools } from './tools/info.js';
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
  const filter = buildToolFilter(config);

  const api = new MealieApi(config);
  const confirmations = new ConfirmationStore();
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

  // Read-only mode does not register the write tools at all. Rejecting them at
  // call time would still advertise capabilities the server refuses to provide.
  if (!config.readOnly) {
    registerRecipeWriteTools(server, api, config, confirmations);
    // preview_recipe_url is a read tool by nature, but it sits with the import
    // tools because it shares their schema and their risk: it makes the Mealie
    // server fetch an arbitrary URL. In read-only mode none of them are offered.
    registerImportTools(server, api, config);
    registerOrganizerWriteTools(server, api, confirmations);
    registerFoodWriteTools(server, api, confirmations);
    registerMealplanWriteTools(server, api, confirmations);
    registerShoppingWriteTools(server, api, confirmations);
    registerCookbookWriteTools(server, api, confirmations);
    registerSharingWriteTools(server, api, config, confirmations);
    registerEngagementWriteTools(server, api, currentUser, confirmations);
  }

  return server;
}
