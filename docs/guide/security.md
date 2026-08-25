# Security

This page is the prose version of [SECURITY.md](https://github.com/ni-c/mealie-mcp/blob/main/SECURITY.md).

## Trust model

A Mealie API token acts as exactly one Mealie user and inherits that user's
group, household and permission flags. Whoever holds it can read and rewrite that
user's whole recipe collection, meal plans, shopping lists and cookbooks, and —
through `create_share_token` — publish any recipe at a URL that needs no login.

Give the server a **dedicated, non-admin user**. Mealie's admin-only surface
(backups, restore, user management, group settings, AI provider configuration) is
not exposed by any tool here, but a token minted from an admin account still
carries those rights if anything else ever reaches the API with it.
`MEALIE_READ_ONLY=true` narrows the server further: the write and import tools
are not registered at all.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not
point this server at an instance whose data you would not put in a model's
context.

## Not exposed, on purpose

Everything under `/api/admin` (backups, restore, maintenance, user, group and
household management, email, AI provider settings), `/api/users/api-tokens` (a
tool that mints API credentials is privilege-escalation surface), the
authentication routes, user CRUD and passwords, webhooks, event notifications and
recipe actions (all three trigger outbound HTTP from the instance), meal plan
rules, migrations, seeders, invitations, bulk export and ZIP download, and asset
and image uploads.

`PUT /api/recipes/{slug}` is not exposed either: it replaces the entire 33-field
recipe object, so a partial update through it silently drops ingredients, steps
and tags. `update_recipe` uses `PATCH`.

## Confirmation tokens

Deleting a recipe, organizer, cookbook, shopping list or comment, merging foods
or units, and creating a public share link all require a server-generated token:
the first call returns the token together with a description of what is about to
happen, the second call — same tool, same arguments, plus the token — performs
it.

The tokens are single-use and bound to the specific target, so a model cannot
satisfy the gate on its own and a token issued for one target cannot be replayed
against another. For operations on a set of ids the token is bound to a
fingerprint of the whole sorted set — a confirmation for three shopping-list
items cannot delete a fourth appended between the two calls — and for a merge to
the direction as well, because swapping the arguments would destroy the wrong
record.

`create_share_token` is guarded even though it destroys nothing: it is the one
tool that widens who can see the data, and unlike a deletion the effect is
invisible until someone uses the link. `delete_share_token` needs no
confirmation — it narrows access.

Confirmation prompts quote **no upstream text** — ids, counts and flags only —
so a hostile recipe name cannot ride along into the prompt the user approves.

## Untrusted content

**Recipes are attacker-controlled text.** A recipe imported from a website
carries whatever that site wrote, and it stays in the database afterwards, so the
content comes back through `get_recipe` and `search_recipes` long after the
import. Comments come from other users of the instance. Every tool result that
can contain instance content is therefore prefixed with an explicit
untrusted-content marker telling the model to treat it as data, not as
instructions.

**Mealie performs the fetch, not this server.** `import_recipe_from_url` and
`preview_recipe_url` hand a URL to Mealie, which retrieves it from inside its own
network and hands back what it read. URLs are therefore restricted to `http` and
`https` — zod's `.url()` accepts `file:`, `javascript:` and `data:` — and loopback and
link-local hosts are refused, including the cloud metadata endpoint `169.254.169.254`,
the hostnames that resolve to it on an instance (`metadata.google.internal`,
`instance-data`), and the endpoints that sit outside that range: `100.100.100.200`
(Alibaba Cloud) and `192.0.0.192` (Oracle).

Addresses are classified numerically, not by comparing strings: `URL` rewrites an
IPv4-mapped IPv6 literal before any check sees it, so `http://[::ffff:169.254.169.254]/`
arrives as `[::ffff:a9fe:a9fe]` while a dual-stack client dials it as plain
`169.254.169.254`. What is sent to Mealie is the parsed URL rather than the string that
came in, so the address that was checked is the one fetched.

A hostname is also resolved and every address behind it checked — which is more than
Mealie does for itself, since Mealie looks only at the first `gethostbyname` answer. Be
clear about what that step cannot do, though: a name this server fails to resolve within
three seconds is passed on rather than refused. That is deliberate, because Mealie may
sit in a different network with its own resolver — but it also means a resolver with DNS
rebind protection, which is the normal setup for the self-hosting audience, turns
"resolves to something internal" into "does not resolve" and hands the name straight
through. `http://169.254.169.254.nip.io/` is passed on for exactly that reason.

**Private LAN ranges are allowed here as of 0.1.2**, where earlier versions refused
them. Do not read that as "Mealie can now be pointed at your LAN": Mealie has refused
private addresses itself since v1.4.0, in its own HTTP transport, so such an import
still fails — just further downstream and with a worse error message. The change is
about having one classifier across these servers rather than about granting reach.

Two things this does not cover. `import_recipe_from_html_or_json` takes a document
rather than a URL, and Mealie reads the image address out of that document and fetches
it; this server never sees that address. And a redirect is a URL it never saw either.
The real boundary is Mealie's own network egress.

## Bounded responses

Oversized results drop whole items rather than cutting the JSON mid-string, and
a response body is never read past 8 MB. Redirects are refused so the token
cannot be resent to another host.

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/ni-c/mealie-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include
real credentials, tokens, hostnames or private configuration in a report. You
can expect an initial response within a week; fixed vulnerabilities are
published as a new release with a note in the changelog. Only the latest release
and the current `main` branch receive security fixes.
