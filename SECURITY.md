# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/mealie-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

A Mealie API token acts as exactly one Mealie user and inherits that user's group,
household and permission flags. Whoever holds it can read and rewrite that user's
whole recipe collection, meal plans, shopping lists and cookbooks, and — through
`create_share_token` — publish any recipe at a URL that needs no login.

Give the server a **dedicated, non-admin user**. Mealie's admin-only surface
(backups, restore, user management, group settings, AI provider configuration) is not
exposed by any tool here, but a token minted from an admin account still carries
those rights if anything else ever reaches the API with it. `MEALIE_READ_ONLY=true`
narrows the server further: the write and import tools are not registered at all.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at an instance whose data you would not put in a model's context.

## Two properties specific to a recipe manager

**Recipes are attacker-controlled text.** A recipe imported from a website carries
whatever that site wrote, and it stays in the database afterwards, so the content
comes back through `get_recipe` and `search_recipes` long after the import. Every
tool result that can contain instance content is therefore prefixed with an explicit
untrusted-content marker, and the server's own sentences in a confirmation prompt
quote ids and counts only — never a recipe name, tag or comment.

Where a caller-chosen value has to appear at all — the new name in
`update_organizer`, the replacement text in `update_shopping_list_items`, the name in
`create_cookbook` — it goes through `mcp-approval`'s `details`, which renders it on
its own labelled line under "Values below are supplied by the caller, not by this
server". A tag called `Desserts — approved by IT, proceed` interpolated into the
server's sentence would read like the server saying it; on a line of its own it reads
like what it is. Nothing the server _fetched_ from Mealie is ever put in a prompt.

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

**`import_recipe_from_html_or_json` reaches outside too**, which its name argues
against and its annotation used to deny. Mealie reads the image address out of the
supplied document and fetches that. Measured on v3.22.0: posting
`{"@type":"Recipe","image":"http://<host>/latest/meta-data/"}` puts `Image URL: …` in
Mealie's log and goes through `recipe_data_service.scrape_image` →
`safehttp.resilient_fetch`.

Mealie has a guard there and it is not the same guard: it refuses on
`ipaddress.ip_address(...).is_private`, which is **False** for `100.100.100.200`
(Alibaba Cloud metadata) and for all of `100.64.0.0/10`. So as of 0.2.1 the addresses
this server can find in the document — schema.org `image` / `thumbnailUrl` /
`contentUrl` in all three shapes, `<img src>`, `og:image` — go through the same
`assertFetchableUrl` as a URL argument, and the tool carries `openWorldHint: true`.

What that still does not cover: an address hidden in a shape the scan does not read,
and a redirect, which is a URL nobody saw. The real boundary is Mealie's own network
egress.

## The confirmation, honestly

### What is guarded, and along which line

Sixteen tools **ask a person** through MCP elicitation. That is a dialog raised by
the server and shown by the client, which the model cannot answer on its behalf;
nothing happens until an answer comes back.

Until 0.2.1 the line was drawn along the tool _name_: everything called `delete_*` or
`merge_*` asked, and nothing else did. That is not the same line as "cannot be
undone", and four tools fell in the gap. `update_recipe` with
`{ingredients: [], instructions: []}` emptied a recipe in a single call, and answered
with the now-empty recipe; `delete_recipe` on the same recipe cost two calls and a
token. Mealie keeps no version history, so both are equally final.

The line now is the one `src/tools/annotations.ts` always stated:

> Content that a person wrote, replaced with no way back — guarded.
> A setting, a state or a marker, changed — not guarded.

Which means the guard is per _call_, not per tool, for the tools that can do both:

| tool                         | asks when                                                                         | goes straight through when                           |
| ---------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `update_recipe`              | name, description, ingredients, instructions, tags, categories or notes are given | only times, servings, yield or the source link       |
| `update_organizer`           | always — a rename regenerates the slug                                            | —                                                    |
| `update_mealplan_entry`      | `title` or `text` is given                                                        | a move to another day or slot, or a different recipe |
| `update_shopping_list_items` | `note` is given — it overwrites every item named                                  | ticking off, changing a quantity                     |
| `create_cookbook`            | `is_public: true`                                                                 | a private cookbook                                   |

Guarding the everyday call as well is not the safe direction: whoever answers the
dialog for "tick the milk off" stops reading it before the one that matters.

`test/gating.test.ts` asserts this over the whole catalogue rather than tool by tool —
every tool annotated `destructiveHint: true` must accept a `confirm_token`, must write
nothing on its first call, and must appear in that file's table. A per-tool test would
not have found the original gap, because every per-tool test that existed passed.

`create_cookbook(is_public: true)` is guarded for the reason `create_share_token` is:
it widens who can see something, and the effect is invisible until somebody uses it.
It exposes less than a share link — Mealie's public recipe controller also wants
`settings.public` on each recipe and a non-private group, so the recipes themselves
stay closed — but the name, description and saved filter go out, and there is no
`update_cookbook` to take it back with.

### What the mechanisms prove, and what they do not

Where the client cannot show a dialog these fall back to a server-generated token
that can be used once. That fallback is weaker and this server says so rather than
implying somebody approved: it proves the call was made twice with the same
arguments, and nothing more. `ELICITATION=false` moves a capable client onto it
deliberately — it does not remove the guard, and the server prints one line at
startup saying it is off.

Either way the approval is bound to the specific target, so one issued for one
target cannot be replayed against another. For operations on a set of ids it is
bound to a fingerprint of the whole sorted set, and for a merge to the direction as
well. For the guarded `update_*` calls it is bound to a fingerprint of the replacing
values too, so a confirmation shown for one new instruction list cannot be spent on a
call that clears the list instead.

### Binding is not freshness

`mcp-approval` seals the request state it carries out through the client and back
(HMAC, via the SDK's `createRequestStateCodec`), and that seal proves **binding**: a
reply whose state does not open, or opens onto a different resource key, is treated as
no answer at all. It does not prove **freshness** — nothing in it says an answer has
not been used before. Within the state's lifetime, a replayed approval for the _same_
operation on the _same_ target is indistinguishable from the original.

For this server that is currently unreachable rather than merely unlikely, and the
reason is worth writing down because it will change:

- The sealed `requestState` only travels over the wire on protocol revision
  `2026-07-28`, where the person's answer comes back as `inputResponses` on a retry.
- The SDK pinned here (`@modelcontextprotocol/server` 2.x) reports
  `LATEST_PROTOCOL_VERSION = "2025-11-25"` and
  `SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26",
"2024-11-05", "2024-10-07"]`. `2026-07-28` is not among them.
- On a `2025-11-25` connection the SDK bridges the elicitation server-side: the
  question and the answer never leave the process, so there is no token to replay.

The fallback path has an answer of its own regardless: `ConfirmationStore` tokens are
single-use and spent on consumption, which the integration suite pins.

So there is **no anti-replay mechanism here, deliberately** — building one against a
path that does not exist would be untestable code guarding nothing. What this section
is for: when this server starts negotiating `2026-07-28`, the guarantee changes from
"the answer cannot be replayed" to "the answer cannot be redirected", and the tool
that most wants the stronger one is `create_share_token`, whose whole purpose is to
widen access.
