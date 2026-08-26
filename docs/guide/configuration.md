# Configuration

See the [environment variable reference](/reference/environment) for the full table.

## Getting a token

Create the token in Mealie under **Settings → API Tokens**. The token acts as the
user who created it and inherits that user's group, household and permission
flags — there are no finer-grained scopes in Mealie.

Give the server a **dedicated, non-admin user**. The admin-only surface is not
exposed by any tool here, but a token minted from an admin account still carries
those rights if anything else ever reaches the API with it. A sensible user for
this server has `canOrganize` (needed for tags, categories, foods and units) and
neither `canManage` nor `canInvite`.

Once read, the token is deleted from the process environment, so child processes
cannot pick it up out of `/proc/<pid>/environ`.

## Required variables

| Variable           | Description                                                           |
| ------------------ | --------------------------------------------------------------------- |
| `MEALIE_URL`       | Base URL of the instance, e.g. `https://mealie.example.com`           |
| `MEALIE_API_TOKEN` | Token from Settings → API Tokens; it acts as the user who created it. |

A missing credential is a warning, not a fatal error: the server still completes
the MCP handshake and answers `tools/list`, and every actual call fails with
setup instructions. A **malformed** `MEALIE_URL` exits immediately — that one
could send the token to the wrong host. URLs with embedded credentials, a query
string or a fragment are rejected for the same reason.

## Optional variables

| Variable                 | Description                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| `MEALIE_READ_ONLY`       | Exactly `true` registers the 17 read tools only                             |
| `MEALIE_ACCEPT_LANGUAGE` | e.g. `de-DE`; localises unit and label names                                |
| `MEALIE_INSECURE_TLS`    | Exactly `true` accepts a self-signed certificate, scoped to this connection |

::: warning Booleans compare against the literal string `true`
`MEALIE_READ_ONLY=1`, `yes` or `True` all leave the flag **off**. A typo fails
off, never on — check the startup line on stderr, which reports the mode in
effect.
:::

## TLS

Prefer `https://`. Using plain `http://` to a non-local host prints a warning:
the API token would travel unencrypted.

If the instance uses a self-signed certificate, `MEALIE_INSECURE_TLS=true`
disables certificate verification **for this connection only** — it does not
touch `NODE_TLS_REJECT_UNAUTHORIZED` or affect any other TLS connection the
process makes.

## Localisation

`MEALIE_ACCEPT_LANGUAGE` (e.g. `de-DE`) is sent as the `accept-language` header,
which Mealie honours on nearly every endpoint. It localises unit names, label
names and validation messages. Unset, the choice is left to the server default.

## Choosing the tools that load

Read-only mode is one cut, along a line this server drew for you.
`MEALIE_ALLOW_TOOLS` and `MEALIE_DENY_TOOLS` let you draw your own:

```sh
MEALIE_ALLOW_TOOLS=essential
MEALIE_ALLOW_TOOLS=search_recipes,get_recipe,import_recipe_from_url
MEALIE_DENY_TOOLS=delete_*
```

Why bother, when all fifty-two work: a model chooses the right tool far more
reliably from a handful than from a long list, and every tool it can see costs
context on every single request. If this is the only MCP server in a session,
fifty-two is fine. If it is one of six, it is not.

**The syntax.** Comma-separated entries. An entry is either an exact tool name or
a prefix with a trailing `*` — `list_*` matches every tool whose name starts with
`list_`. Entries are trimmed and case-insensitive, empty ones are ignored, and an
empty value counts as unset. Nothing else is a pattern: `*_x` and `list_*_x` are
rejected rather than silently matching nothing.

**`essential`** is a curated preset of eight:

`search_recipes`, `get_recipe`, `import_recipe_from_url`, `create_recipe`, `get_todays_meals`, `create_mealplan_entry`, `list_shopping_lists`, `add_recipe_to_shopping_list`.

It composes — naming a tool alongside it puts that one back, and
`MEALIE_DENY_TOOLS` takes one away.

**Both together.** `MEALIE_ALLOW_TOOLS` decides what is in;
`MEALIE_DENY_TOOLS` is then subtracted from the result. With only a deny list,
everything else stays.

**A name that matches nothing stops the server**, with the offending entry and the
list of real names. That is deliberate: the alternative is a tool quietly missing
from `tools/list`, and nobody traces an absence back to an environment variable.
The same applies to a pattern that matches no tool.

**With read-only mode**, the write tools are not registered at all, so naming
one explicitly in `MEALIE_ALLOW_TOOLS` is an error that says so — rather than
calling a tool unknown when it plainly exists. A _pattern_ that covers write
tools is fine and simply contributes nothing, and
`MEALIE_ALLOW_TOOLS=essential` narrows to the read half of the preset.

::: tip It is the same cut, not a second one
A filtered tool is never registered, so it is absent from `tools/list` and
unknown to `tools/call` alike — exactly what `MEALIE_READ_ONLY` does to a
write tool. There is no "hidden but callable" state to reason about.
:::
