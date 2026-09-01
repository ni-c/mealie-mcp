# Environment variables

| Variable                 | Required | Default | Description                                                                              |
| ------------------------ | -------- | ------- | ---------------------------------------------------------------------------------------- |
| `MEALIE_URL`             | yes      | —       | Base URL of the Mealie instance, e.g. `https://mealie.example.com`                       |
| `MEALIE_API_TOKEN`       | yes      | —       | API token from Settings → API Tokens; acts as the user who created it                    |
| `MEALIE_READ_ONLY`       | no       | `false` | Exactly `true` registers only the 18 read tools                                          |
| `MEALIE_ACCEPT_LANGUAGE` | no       | —       | Sent as `accept-language`, e.g. `de-DE`; localises unit and label names                  |
| `MEALIE_INSECURE_TLS`    | no       | `false` | Exactly `true` accepts a self-signed certificate — scoped to this connection only        |
| `ELICITATION`            | no       | `true`  | `false` replaces the approval dialog with the two-call token. **Not prefixed**            |

::: warning The booleans compare against the literal string `true`
`MEALIE_READ_ONLY` and `MEALIE_INSECURE_TLS` are only on when their value is
exactly the string `true`. `1`, `yes`, `True` — any typo — fails **off**. The
startup banner on stderr reports the mode actually in effect; check it after
changing the configuration.
:::

## `ELICITATION`

Whether a client that *can* show a dialog is asked before a guarded tool acts.
Default `true`. `false` takes the two-call-token path instead — it does not remove
the guard, and a server started with it off prints one line saying so.

Two ways it differs from every other variable here:

- **No prefix.** One `export ELICITATION=false` reaches every MCP server in the
  same environment, not just this one. That is the point of it and also its risk;
  see [Asking a person](/guide/approval).
- **Fatal on anything else.** Where the `MEALIE_*` booleans fail *off* on a typo,
  this one stops the server with exit code 1. It is the only variable here that
  defaults to *on*, and a typo that fell back to the default would leave the
  dialog running while you believed it was off.

Values are trimmed and matched case-insensitively. It is read *after*
`MEALIE_API_TOKEN` is deleted from `process.env`, so the fatal path cannot leave
the token sitting there for a crash reporter.

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

Exactly `true` registers only the 18 read tools; the 34 write and import tools
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

## Narrowing the tool list

| Variable | Required | Description |
| --- | --- | --- |
| `MEALIE_ALLOW_TOOLS` | no | Tool names, `list_*` prefixes or `essential`; only these register |
| `MEALIE_DENY_TOOLS` | no | Same syntax; subtracted from whatever the allow list left |

Both are comma-separated. Each entry is either an exact tool name or a prefix with
a single trailing `*`. Entries are trimmed and matched case-insensitively; empty
entries are ignored, and a value that is empty or only whitespace counts as unset —
`MEALIE_ALLOW_TOOLS=` in a compose file does not mean "allow nothing".
`essential` is recognised only in the allow list, and selects `search_recipes`, `get_recipe`, `import_recipe_from_url`, `create_recipe`, `get_todays_meals`, `create_mealplan_entry`, `list_shopping_lists`, `add_recipe_to_shopping_list`.

**An entry that matches no tool aborts startup**, naming the entry and listing the
valid names, as does a malformed pattern such as `*_x` or `list_*_x`. The
alternative — ignoring the entry — leaves a tool missing from `tools/list` with
nothing pointing at the cause. If both lists together remove everything, the server
refuses to start rather than offering an empty tool list.

Under `MEALIE_READ_ONLY`, an exact write-tool name in the allow list is an
error naming the read-only setting rather than "unknown tool"; a pattern covering
write tools is accepted and merely contributes nothing, with a warning on stderr.
Deny entries are exempt: denying an already-suppressed tool is how a defensive
list is written.
