# FAQ & troubleshooting

## Every call fails with "missing required environment variable(s)"

The server started without `MEALIE_URL` and/or `MEALIE_API_TOKEN`. That is
deliberate — the server completes the MCP handshake and lists its tools without
credentials so it can be introspected — but no call can succeed. Set both
variables in the client config; see [Connecting clients](/guide/clients).

## I set `MEALIE_READ_ONLY=1` and the write tools are still there

The two boolean variables compare against the literal string `true`, so `1`,
`yes` and `True` all leave them **off**. A typo fails off, never on. The startup
line on stderr reports the mode actually in effect — check it after changing the
config.

## A write tool fails with 403

The token acts as the user who created it, with that user's permission flags.
Call `get_about`: it reports the identity behind the token and the three flags
that gate the write tools in practice (`canOrganize`, `canManage`, `canInvite`).
Organizer, food and unit management needs `canOrganize`.

## `suggest_recipes` returns nothing

That tool ranks recipes by the foods and tools marked "on hand" in Mealie, so it
only produces anything on an instance that maintains structured foods, units and
an on-hand pantry. On a collection of plain-text ingredients it returns nothing —
use `search_recipes` there. Likewise, `list_foods` and `list_units` being empty
means the instance never seeded them, not a failure.

## `import_recipe_from_url` refuses my URL

URLs handed to the import tools must be `http`/`https`, and must not address
Mealie's own machine: loopback and link-local addresses are refused, because
Mealie fetches the URL from inside its own network and hands back what it read —
see [Security](/guide/security#untrusted-content).

A private LAN address is no longer refused *here* as of 0.1.2, but that will not
make it work: Mealie refuses private addresses in its own HTTP transport, so the
import fails on its side instead. If the page needs a login, or
Mealie cannot parse it, fetch the HTML yourself and use
`import_recipe_from_html_or_json`.

## `import_recipe_from_image` fails

That tool has Mealie run the photo through its configured AI provider. Without
one the call fails — and the setting itself is only visible to a group manager
or admin in Mealie's UI.

## An import came out empty or garbled

Run `preview_recipe_url` first: it fetches the page and reports what Mealie
would extract, without saving anything. If the preview is already empty, the
page's markup is the problem, not the import.

## A dialog appeared before a delete

That is the [approval flow](/guide/approval) working. Where your client supports
MCP elicitation, the eleven guarded tools raise a question the model cannot
answer on its behalf, and nothing happens until you answer it.

## A delete tool answered with a token instead of deleting

That is the **fallback**, for a client that cannot show a dialog. The first call
describes what is about to happen and returns a single-use token, the second —
same arguments plus `confirm_token` — performs it. Tokens expire after a few
minutes and are bound to the specific target.

If your client *can* show dialogs and you are still seeing tokens, check whether
`ELICITATION` is set to `false` somewhere in the environment: it deliberately
carries no `MEALIE_` prefix, so it may have been meant for a different server.

## Why is there no bulk export / backup / user management tool?

By design. The point of the server is a curated surface; the
[list of deliberately unexposed routes](/guide/security#not-exposed-on-purpose)
explains what is missing and why.

## Self-signed certificate errors

Set `MEALIE_INSECURE_TLS=true` (exactly `true`). It disables certificate
verification for the Mealie connection only, not for the whole process. Prefer a
real certificate where you can.

## Where do I report a bug or ask a question?

- Questions and ideas → [Discussions](https://github.com/ni-c/mealie-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/mealie-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/mealie-mcp/security/advisories/new),
  never a public issue

## One tool I expected is missing

Something narrowed the list. In order of likelihood:

- `MEALIE_READ_ONLY` is set, and it is a write tool.
- `MEALIE_ALLOW_TOOLS` is set and does not name it — it is an allow list, so
  anything not named is out.
- `MEALIE_DENY_TOOLS` names it, possibly through a prefix such as `list_*`.

A filtered tool is not registered at all, so it is missing from `tools/list` and
answers `tools/call` with "tool not found". There is no state where it is hidden
but still callable.

What it is _not_ is a typo in one of those variables: an entry that matches no
tool stops the server at startup and says which entry it was. See
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).
