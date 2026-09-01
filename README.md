# mealie-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/mealie-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/mealie-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ni-c%2Fmealie-mcp)](https://www.npmjs.com/package/@ni-c/mealie-mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40ni-c%2Fmealie-mcp)](https://www.npmjs.com/package/@ni-c/mealie-mcp)
[![node](https://img.shields.io/node/v/%40ni-c%2Fmealie-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ni-c%2Fmealie-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Fmealie--mcp-blue)](https://github.com/ni-c/mealie-mcp/pkgs/container/mealie-mcp)
[![docs](https://img.shields.io/badge/docs-mealie--mcp.ni--c.de-informational)](https://mealie-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[Mealie](https://mealie.io), the self-hosted recipe manager and meal planner.

Lets MCP clients like Claude Code, Claude Desktop or Codex work with your recipe
collection: search and read recipes with their ingredients and steps, import new ones
from a website, keep tags and categories tidy, plan meals, build shopping lists from
those plans, and record what was actually cooked.

Fifty-two tools is the ceiling, not the floor: `MEALIE_ALLOW_TOOLS=essential`
registers a curated eight instead, and a model picks the right tool far more
reliably from eight than from fifty-two — see
[choosing which tools load](#choosing-which-tools-load).

![Demo](https://mealie-mcp.ni-c.de/demo.gif)

<!-- <picture> is resolved against the colour scheme of the page showing it, so GitHub
     picks the variant that matches its own theme toggle. npm strips <picture> and
     <source> when it sanitises the README and keeps the <img>, which is why that
     fallback brings its own dark card instead of relying on a media query. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://mealie-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://mealie-mcp.ni-c.de/architecture-light.svg">
  <img src="https://mealie-mcp.ni-c.de/architecture.svg" alt="An MCP client speaks stdio to mealie-mcp, which calls the Mealie REST API over HTTPS; Mealie fetches recipe websites server-side, which is why the URL guard refuses its own loopback and link-local range" width="800">
</picture>

Mealie's REST API has 259 operations across 175 paths. This server exposes **52
tools**, chosen so that the common tasks are one call and the dangerous surface is
not reachable at all. Verified against **Mealie v3.22.0**; the source of truth for
every request shape is the `GET /openapi.json` of a running instance, not the
published documentation, which is out of date in several places.

## Requirements

- Node.js 22 or newer
- A Mealie instance and an API token from **Settings → API Tokens**

## Configuration

| Variable                 | Required | Description                                                                        |
| ------------------------ | -------- | ---------------------------------------------------------------------------------- |
| `MEALIE_URL`             | yes      | Base URL, e.g. `https://mealie.example.com`                                        |
| `MEALIE_API_TOKEN`       | yes      | Token from Settings → API Tokens. It acts as the user who created it.              |
| `MEALIE_READ_ONLY`       | no       | Exactly `true` registers the 18 read tools only                                    |
| `MEALIE_ACCEPT_LANGUAGE` | no       | e.g. `de-DE`; localises unit and label names                                       |
| `MEALIE_INSECURE_TLS`    | no       | Exactly `true` accepts a self-signed certificate, scoped to this connection        |
| `MEALIE_ALLOW_TOOLS`     | no       | Comma-separated tool names, `list_*` prefixes, or `essential` for a curated preset |
| `MEALIE_DENY_TOOLS`      | no       | Same syntax; removed from whatever `MEALIE_ALLOW_TOOLS` left                       |

The two booleans are compared against the literal string `true`, so a typo leaves
them **off** — check the startup line on stderr, which reports the mode in effect.

The token is removed from the process environment once it has been read, so child
processes cannot pick it up out of `/proc/<pid>/environ`.

### Choosing which tools load

`MEALIE_ALLOW_TOOLS` and `MEALIE_DENY_TOOLS` take comma-separated tool names;
a trailing `*` matches a whole family. `essential` is a curated preset of
eight: `search_recipes`, `get_recipe`, `import_recipe_from_url`, `create_recipe`, `get_todays_meals`, `create_mealplan_entry`, `list_shopping_lists`, `add_recipe_to_shopping_list`.

```sh
MEALIE_ALLOW_TOOLS=essential
MEALIE_ALLOW_TOOLS=search_recipes,get_recipe,import_recipe_from_url
MEALIE_DENY_TOOLS=delete_*
```

An entry that matches no tool aborts startup and names it, so a typo cannot
silently hide a tool — an absent tool is not something anyone traces back to an
environment variable. A filtered tool is never registered, so it is absent from
`tools/list` and unknown to `tools/call` alike, exactly like a write tool under
`MEALIE_READ_ONLY`.

If you run several of these servers at once, [mcp-hub](https://mcp-hub.ni-c.de)
is the other answer — its `/hub` endpoint replaces every server's tools with six
meta-tools.

## Install

Claude Desktop, or any MCP client that takes a JSON config:

```json
{
  "mcpServers": {
    "mealie": {
      "command": "npx",
      "args": ["-y", "@ni-c/mealie-mcp"],
      "env": {
        "MEALIE_URL": "https://mealie.example.com",
        "MEALIE_API_TOKEN": "…"
      }
    }
  }
}
```

```sh
claude mcp add mealie \
  -e MEALIE_URL=https://mealie.example.com \
  -e MEALIE_API_TOKEN=… \
  -- npx -y @ni-c/mealie-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.mealie]
command = "npx"
args = ["-y", "@ni-c/mealie-mcp"]

[mcp_servers.mealie.env]
MEALIE_URL = "https://mealie.example.com"
MEALIE_API_TOKEN = "…"
```

Or as a container:

```sh
docker run --rm -i \
  -e MEALIE_URL=https://mealie.example.com \
  -e MEALIE_API_TOKEN=… \
  ghcr.io/ni-c/mealie-mcp
```

To poke at the tools interactively:

```sh
npx @modelcontextprotocol/inspector npx -y @ni-c/mealie-mcp
```

## Tools

**Recipes** — `search_recipes`, `get_recipe`, `suggest_recipes`, `create_recipe`,
`update_recipe`, `duplicate_recipe`, `set_recipe_last_made`, `delete_recipe` 🔒

**Import** — `preview_recipe_url` (dry run, saves nothing), `import_recipe_from_url`,
`import_recipe_from_html_or_json`, `import_recipe_from_image`

**Organizing** — `list_organizers`, `create_organizer`, `update_organizer`,
`delete_organizer` 🔒 — each takes `kind: tag | category | tool`

**Ingredients** — `list_foods`, `create_food`, `merge_foods` 🔒, `list_units`,
`create_unit`, `merge_units` 🔒, `parse_ingredients`

**Meal plans** — `list_mealplans`, `get_todays_meals`, `create_mealplan_entry`,
`create_random_meal`, `update_mealplan_entry`, `delete_mealplan_entry` 🔒

**Shopping** — `list_shopping_lists`, `get_shopping_list`, `create_shopping_list`,
`delete_shopping_list` 🔒, `add_shopping_list_items`, `update_shopping_list_items`,
`delete_shopping_list_items` 🔒, `add_recipe_to_shopping_list`,
`remove_recipe_from_shopping_list`

**Cookbooks** — `list_cookbooks`, `get_cookbook`, `create_cookbook`,
`delete_cookbook` 🔒

**Notes and sharing** — `set_recipe_rating`, `add_recipe_comment`,
`delete_recipe_comment` 🔒, `list_recipe_comments`, `list_recipe_timeline`,
`create_timeline_event`, `list_share_tokens`, `create_share_token` 🔒,
`delete_share_token`

**Instance** — `get_about`

🔒 needs a confirmation token: call once to receive one, then again with it.

Recipes can be addressed by slug or by UUID everywhere — Mealie splits its
identifier space between the two, and the tools resolve whichever they are given.

## Not exposed, on purpose

Everything under `/api/admin` (backups, restore, maintenance, user, group and
household management, email, AI provider settings), `/api/users/api-tokens` (a tool
that mints API credentials is privilege-escalation surface), the authentication
routes, user CRUD and passwords, webhooks, event notifications and recipe actions
(all three trigger outbound HTTP from the instance), meal plan rules, migrations,
seeders, invitations, bulk export and ZIP download, and asset and image uploads.

`PUT /api/recipes/{slug}` is not exposed either: it replaces the entire 33-field
recipe object, so a partial update through it silently drops ingredients, steps and
tags. `update_recipe` uses `PATCH`.

## Safety

- **Instance content is untrusted input.** Recipes are routinely scraped from
  arbitrary websites and comments come from other users, so every tool result that
  can contain instance content is prefixed with an explicit marker telling the model
  to treat it as data. This matters after the import too: the text stays in the
  database and comes back through `get_recipe`.
- **The import tools make Mealie fetch, not this server.** URLs are restricted to
  `http`/`https`, and loopback and link-local hosts are refused — including the
  cloud metadata endpoints and the hostnames that resolve to them. Addresses are
  compared numerically, so an IPv4-mapped literal such as
  `[::ffff:169.254.169.254]` is caught too, and a hostname is resolved as well —
  best effort, since a name that does not resolve here is passed on. Private LAN
  addresses are passed on as of 0.1.2, but Mealie refuses them itself, so such an
  import fails there rather than here. See SECURITY.md for what the check does not
  cover, including `import_recipe_from_html_or_json`.
- **Confirmation prompts quote no upstream text** — ids, counts and flags only.
- **Responses are bounded**: oversized results drop whole items rather than cutting
  the JSON mid-string, and a response body is never read past 8 MB.
- Redirects are refused so the token cannot be resent to another host.

See [SECURITY.md](SECURITY.md) for the trust model and how to report a
vulnerability.

## Development

```sh
npm install && npm test && npm run build
```

`scripts/verify-live.mjs` exercises all 52 tools against a **throwaway** Mealie
instance; the recipe for setting one up is in [CONTRIBUTING.md](CONTRIBUTING.md).

The architecture diagram and the social card are rendered from
`docs/assets/architecture.source.svg` and `docs/assets/og.json` by
`npm run assets`; CI fails if a rendered copy was edited by hand.

## Releasing

Everything is driven by a tag; there is no manual publish step.

1. Move the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) to the new version
   and date it. The release workflow extracts that section with `awk`, so the
   `## [x.y.z]` heading shape matters.
2. Bump `version` in `package.json`.
3. `npm run lint && npm run build && npm run test:coverage`.
4. Commit, then a **signed annotated** tag:

   ```sh
   git tag -s v0.1.1 -m "v0.1.1"
   git push origin main v0.1.1
   ```

`release.yml` then verifies the tag matches `package.json`, publishes to npm over
**Trusted Publishing** (OIDC — no npm token exists to leak) with provenance, syncs the
version into both `server.json` package entries, publishes to the MCP registry, and
cuts the GitHub release from the changelog section. `ci.yml` pushes the multi-arch
container image to GHCR in parallel.

## License

MIT
