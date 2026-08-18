# Getting started

## Requirements

- Node.js ≥ 22
- A running [Mealie](https://mealie.io) instance (verified against v3.22.0)
- An API token from Mealie's **Settings → API Tokens** — see
  [Configuration](/guide/configuration)

## Run it

```sh
MEALIE_URL=https://mealie.example.com MEALIE_API_TOKEN=… npx -y @ni-c/mealie-mcp
```

The server speaks MCP over stdio, so it is normally started by an MCP client
rather than by hand — see [Connecting clients](/guide/clients) for the config
snippets for Claude Code, Claude Desktop, Codex and others.

Without credentials the server still starts and lists its tools; every call then
fails with setup instructions instead of reaching the API. This lets registries
and inspectors introspect the tool catalog without a live instance.

## First calls

A good smoke test once the server is connected:

1. `get_about` — reports the Mealie version and the identity the token acts as,
   including the permission flags that decide which write tools will succeed.
2. `search_recipes` with a search term — returns recipe summaries.
3. `get_recipe` with one of the returned slugs — returns the full recipe with
   ingredients and steps.

## Read-only mode

Set `MEALIE_READ_ONLY=true` (exactly the string `true`) to register only the 17
read tools. The 35 write and import tools are not registered at all — a model
cannot call what does not exist. Check the startup line on stderr, which reports
the mode in effect.
