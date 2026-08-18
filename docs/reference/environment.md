# Environment variables

| Variable                 | Required | Default | Description                                                                              |
| ------------------------ | -------- | ------- | ---------------------------------------------------------------------------------------- |
| `MEALIE_URL`             | yes      | —       | Base URL of the Mealie instance, e.g. `https://mealie.example.com`                       |
| `MEALIE_API_TOKEN`       | yes      | —       | API token from Settings → API Tokens; acts as the user who created it                    |
| `MEALIE_READ_ONLY`       | no       | `false` | Exactly `true` registers only the 17 read tools                                          |
| `MEALIE_ACCEPT_LANGUAGE` | no       | —       | Sent as `accept-language`, e.g. `de-DE`; localises unit and label names                  |
| `MEALIE_INSECURE_TLS`    | no       | `false` | Exactly `true` accepts a self-signed certificate — scoped to this connection only        |

::: warning The booleans compare against the literal string `true`
`MEALIE_READ_ONLY` and `MEALIE_INSECURE_TLS` are only on when their value is
exactly the string `true`. `1`, `yes`, `True` — any typo — fails **off**. The
startup banner on stderr reports the mode actually in effect; check it after
changing the configuration.
:::

## `MEALIE_URL`

Must be an absolute `http://` or `https://` URL. The server exits at startup if
the value

- does not parse as a URL,
- uses a scheme other than `http` or `https`,
- embeds credentials (`https://user:pass@…` — use `MEALIE_API_TOKEN` instead), or
- carries a query string or fragment (either would silently corrupt every
  request URL built from the base).

Plain `http://` to a non-loopback host starts, but prints a warning: the token
would travel unencrypted.

## `MEALIE_API_TOKEN`

Created in Mealie under **Settings → API Tokens**. It is a secret: it acts as
the user who created it and inherits that user's group, household and
permissions — use a dedicated, non-admin user (see the
[trust model](/guide/security#trust-model)).

The token is **deleted from the process environment** as soon as it has been
read, so child processes cannot pick it up out of `/proc/<pid>/environ`.

## `MEALIE_READ_ONLY`

Exactly `true` registers only the 17 read tools; the 35 write and import tools
are not registered at all, so a model cannot call them and does not see them in
the catalog.

## `MEALIE_ACCEPT_LANGUAGE`

Mealie honours the `accept-language` header on nearly every endpoint; it
localises unit names, label names and validation messages. Unset, the choice is
left to the server default.

## `MEALIE_INSECURE_TLS`

Exactly `true` accepts a self-signed certificate. The override is scoped to the
Mealie connection — it does not set `NODE_TLS_REJECT_UNAUTHORIZED` and does not
affect any other TLS connection the process makes.

## Missing configuration

Missing credentials are a warning, not a fatal error: the server still completes
the MCP handshake and answers `tools/list`, so registries and sandbox
inspectors can introspect it. Every API call then fails with setup instructions.
A malformed `MEALIE_URL` is the exception and exits immediately — that one could
send the token to the wrong host.
