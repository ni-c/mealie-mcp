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
