# mealie-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[Mealie](https://mealie.io), the self-hosted recipe manager and meal planner.

It gives a model a curated view of a Mealie instance: search and read recipes with
their ingredients and steps, import new ones from a website, keep tags and
categories tidy, plan meals, build shopping lists from those plans, and record what
was actually cooked.

Mealie's REST API has 259 operations across 175 paths. This server exposes **52
tools**, chosen so that the common tasks are one call and the dangerous surface is
not reachable at all. Verified against **Mealie v3.22.0**; the source of truth for
every request shape is the `GET /openapi.json` of a running instance, not the
published documentation, which is out of date in several places.

## Requirements

- Node.js 22 or newer
- A Mealie instance and an API token from **Settings → API Tokens**

## Configuration

| Variable                 | Required | Description                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------------- |
| `MEALIE_URL`             | yes      | Base URL, e.g. `https://mealie.example.com`                                 |
| `MEALIE_API_TOKEN`       | yes      | Token from Settings → API Tokens. It acts as the user who created it.       |
| `MEALIE_READ_ONLY`       | no       | Exactly `true` registers the 17 read tools only                             |
| `MEALIE_ACCEPT_LANGUAGE` | no       | e.g. `de-DE`; localises unit and label names                                |
| `MEALIE_INSECURE_TLS`    | no       | Exactly `true` accepts a self-signed certificate, scoped to this connection |

The two booleans are compared against the literal string `true`, so a typo leaves
them **off** — check the startup line on stderr, which reports the mode in effect.

The token is removed from the process environment once it has been read, so child
processes cannot pick it up out of `/proc/<pid>/environ`.

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

Or as a container:

```sh
docker run --rm -i \
  -e MEALIE_URL=https://mealie.example.com \
  -e MEALIE_API_TOKEN=… \
  ghcr.io/ni-c/mealie-mcp
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
  public `http`/`https` addresses; loopback, private-range, link-local and
  `.lan`/`.internal`/`.local` hosts are refused.
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

## License

MIT
