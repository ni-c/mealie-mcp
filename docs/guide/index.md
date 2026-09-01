# What is mealie-mcp?

mealie-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) server
for [Mealie](https://mealie.io), the self-hosted recipe manager and meal planner.
It gives a model a curated view of a Mealie instance: search and read recipes with
their ingredients and steps, import new ones from a website, keep tags and
categories tidy, plan meals, build shopping lists from those plans, and record what
was actually cooked.

## Why

Mealie's REST API has 259 operations across 175 paths. Exposing all of them to a
model would bury the useful calls under administrative noise — and hand the model
routes nobody wants it to have, like backups, user management and API-token
minting.

This server exposes **52 tools** instead, chosen so that the common tasks are one
call and the dangerous surface is not reachable at all:

- **Common tasks are one call.** `import_recipe_from_url` imports a recipe and
  returns the full result, `add_recipe_to_shopping_list` merges a recipe's
  ingredients into a list, `get_todays_meals` answers the obvious daily question.
  Recipes can be addressed by slug or by UUID everywhere — Mealie splits its
  identifier space between the two, and the tools resolve whichever they are given.
- **The dangerous surface is unreachable.** Everything under `/api/admin`, the
  token-minting route, authentication, webhooks and other outbound-HTTP triggers
  are simply not exposed — see [Security](/guide/security#not-exposed-on-purpose).
- **Destructive calls ask a person.** Deletes, merges and share links raise a real
  dialog through MCP elicitation — see [Asking a person](/guide/approval) — and
  fall back to a server-issued token, which a model cannot fabricate, where the
  client cannot show one.

The server is verified against **Mealie v3.22.0**. The source of truth for every
request shape is the `GET /openapi.json` of a running instance, not the published
documentation, which is out of date in several places.

## What it is not

- **Not an admin tool.** Backups, restore, user, group and household management,
  email and AI-provider settings are deliberately out of reach. Use Mealie's own
  web UI for those.
- **Not a Mealie client library.** The tools are shaped for a model's workflow,
  not as a 1:1 API mapping — several tools combine multiple API calls, and
  responses are trimmed and bounded so they fit a context window.
- **Not a hosted service.** It is a local stdio process started by your MCP
  client, talking to your Mealie instance with your token.
