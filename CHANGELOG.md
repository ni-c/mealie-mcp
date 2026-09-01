# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

### Added

- Tools that need a confirmation now **ask the user**, on clients that can show
  a prompt. The two-call `confirm_token` remains for clients that cannot, so
  nothing that works today stops working — but where a person can be asked, one
  is, instead of a token that only proves the same call was made twice. This
  covers all guarded tools, `create_share_token` among them.

- **`delete_share_token` now asks too.** Its description said in so many words
  that it needed "no confirmation — this narrows access rather than widening it",
  and the direction really is the safe one. What is not is that the link cannot be
  reissued: a new share token is a different URL, so whoever was sent the old one
  finds a dead link, and this server cannot tell whom that was.

- `ELICITATION` switches the dialog off — `false` sends a client that could have
  been asked down the two-call-token path instead. For a scheduled job or a test
  harness, where a dialog is the wrong shape rather than an unwanted one.

  It does **not** remove the guard: there is no setting in which a guarded call
  goes unannounced. Two deliberate rough edges come with it. The variable is
  **not prefixed**, so one `export ELICITATION=false` reaches every MCP server in
  the environment — which is why a server started with it off prints a line
  saying so, and why the fallback text names the server instead of blaming a
  client that was working fine. And a value that is neither `true` nor `false`
  **stops the server**, where the `MEALIE_*` booleans beside it fail _off_ on a
  typo: this is the only variable here that defaults to _on_. It is read after
  `MEALIE_API_TOKEN` is wiped from the environment, so that exit cannot leave the
  token behind.

- A `docs/guide/approval.md` page.

### Fixed

- **`merge_foods` and `merge_units` named the wrong tool.** Both come out of one
  factory, and the factory passed `toolName: 'create_unit'` — a real, unrelated
  tool of this server. That name is printed in two places a caller acts on: the
  fallback instruction ("call `create_unit` again with the token") and the
  sentence after a decline. Callers were being pointed at something that creates
  rather than merges. Introduced on 2026-09-01 with the move to `mcp-approval`.

- Four `update_*` tools were annotated `destructiveHint: false`:
  `update_recipe`, `update_organizer`, `update_mealplan_entry` and
  `update_shopping_list_items`. Mealie keeps no version history, so replacing an
  instruction list leaves nowhere to read the old one back from — that is the
  definition the whole family uses, and Wiki.js's `update_page` is genuinely on
  the other side of it because Wiki.js _has_ page history. The difference is the
  backend, not the verb.

### Changed

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did; the change is the package layout behind it, and it is what lets
  the dialog above work on both protocol eras from one code path — including
  behind a stateless gateway, where the older mechanism silently fell back to
  the weaker token for every client.

- The linter is **oxlint** instead of eslint plus typescript-eslint, which
  lifts the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1,
  so this repository was held on TypeScript 6 by its linter rather than by its
  code.

- The tool filter, the confirmation store, the host classifier and the
  documentation-asset generator now come from **`mcp-tool-allowlist`**,
  **`mcp-approval`**, **`mcp-internal-hosts`** and **`svg-asset-set`** rather
  than from copies kept here — 802 fewer lines, and one place to fix each. None
  of them has a runtime dependency of its own.

- A `confirm_token` that does not match its arguments is **refused with the
  reason** instead of being answered with a fresh prompt, in the same words as
  every other server in the family. The binding is unchanged: a confirmation
  issued for one recipe still cannot delete another. A wrong token also no
  longer voids the outstanding one — voiding it let anyone who could reach the
  tool cancel a pending confirmation by sending rubbish, which protected
  nothing.

### Fixed

- Confirmation tokens are compared with a **constant-time** comparison. The
  copy in this repository used `!==`, which leaks through timing how much of a
  guess was right. Reaching a token still requires having received it in a
  previous tool result, so this closes a margin rather than a hole.

- An entry in `MEALIE_ALLOW_TOOLS` that is not tool-name-shaped is now
  **redacted** in the error rather than quoted back. `MEALIE_TOKEN` and
  `MEALIE_ALLOW_TOOLS` are adjacent lines in every compose file, and a paste
  into the wrong one used to print the credential into the client's log.

## [0.2.0] - 2026-08-27

### Added

- `MEALIE_ALLOW_TOOLS` and `MEALIE_DENY_TOOLS` choose which of the 52
  tools are registered. Both take comma-separated tool names or a prefix with a
  trailing `*`, the allow list decides what is in and the deny list is subtracted
  from it, and `MEALIE_ALLOW_TOOLS=essential` selects a curated eight —
  `search_recipes`, `get_recipe`, `import_recipe_from_url`, `create_recipe`, `get_todays_meals`, `create_mealplan_entry`, `list_shopping_lists`, `add_recipe_to_shopping_list`. A model picks the right tool far more reliably from eight than
  from fifty-two, and every visible tool costs context on every request. Nothing
  changes for an installation that sets neither.

  A filtered tool is not registered at all, so it is absent from `tools/list`
  and answers `tools/call` with "tool not found" — the same cut
  `MEALIE_READ_ONLY` already makes, not a second, weaker one.

  An entry that matches no tool **stops the server at startup**, naming the
  entry and listing the real names, rather than being ignored: an ignored typo
  leaves a tool missing from `tools/list` with nothing pointing at the cause.

### Changed

- The README now carries the same eight badges, in the same order, as every other
  MCP server in this family, all of them reading from npm rather than hard-coded;
  the opening follows one shape; and the standalone "Full documentation" line is
  gone, because the docs badge three lines above it points at the same page.

### Fixed

- The container image no longer ships OpenSSL 3.5.7-r0, which carries
  **CVE-2026-14456** (denial of service via unbounded memory growth). The pinned
  `node:24-alpine` digest is already the newest one; Alpine's fixed 3.5.8-r0 has
  simply not been rebuilt into it yet, so the runtime stage now upgrades
  `libcrypto3` and `libssl3` by name. Upgrading those two rather than running a
  blanket `apk upgrade` keeps the rest of the image exactly as the digest pins
  it. The step can go once the base image ships the fix.

## [0.1.2] - 2026-08-26

### Security

- The host of an import URL is now classified numerically instead of by
  comparing strings, and a hostname is resolved before it is accepted.
  `http://localhost./recipe` — the same name with its root label — walked past
  the old `host === 'localhost'` and `endsWith('.local')` checks, as did
  `http://nas.local./`. A DNS name pointing at `127.0.0.1` walked past all of it,
  because a Zod refinement is synchronous and cannot resolve anything. The check
  therefore moved out of the schema and into the tool handlers, where it can.
- What is sent to Mealie is the parsed URL rather than the string that came in,
  so the address that was checked is the one Mealie fetches.
  `http://ok.example.com\@127.0.0.1/recipe` has the host `ok.example.com` for a
  URL parser and `127.0.0.1` for a fetcher that splits at the `@`.
- The hostnames of the cloud metadata service — `metadata.google.internal`,
  `instance-data` and their siblings — are refused by name. They resolve to
  `169.254.169.254` on the instance and to nothing anywhere else, so resolving
  them is exactly what cannot catch them. So are the endpoints that sit outside
  `169.254/16`: `100.100.100.200` (Alibaba Cloud) and `192.0.0.192` (Oracle).
- An IPv6 scope id is stripped before the address is read. `net.isIP` accepts
  `::ffff:127.0.0.1%eth0`, which made the dotted-quad fold miss its anchor and
  the address come out as routable. A URL cannot carry one, but a resolver
  answer can.

### Changed

- **Private addresses are no longer refused here.** Loopback, link-local and the
  metadata endpoints are still refused, but `10/8`, `172.16/12`, `192.168/16`,
  `fc00::/7`, the rest of carrier-grade NAT and the
  `.lan`/`.local`/`.internal`/`.home` suffixes are not. That is a consistency
  change, not a new capability: Mealie has refused private addresses in its own
  HTTP transport since v1.4.0, so an import that names one still fails — further
  downstream and with a less helpful message. What this server now guards is the
  set of addresses Mealie does _not_ guard for itself, which is why the two
  metadata endpoints outside `169.254/16` were added. If you were relying on this
  check to keep Mealie off your LAN, that job belongs to Mealie's own egress
  rules; `SECURITY.md` says what is and is not covered.
- Bracketed IPv6 literals are no longer refused as a class. They were, because
  classifying them piecemeal was thought to be a losing game — the IPv4-mapped
  forms in particular. The classifier now unwraps those forms instead, so a public
  IPv6 address works while `[::ffff:169.254.169.254]` is still caught.
- A name that a resolver sinkholes — answering `0.0.0.0` or `::`, which is what
  every ad blocker and DNS filter does — is no longer refused as a loopback
  address. That is the resolver declining to answer rather than the name
  addressing the machine, and describing it as loopback made every blocklisted
  domain unusable with a message that was simply wrong.
- The description of `import_recipe_from_html_or_json` no longer claims the tool
  works "without Mealie fetching anything". Mealie does not fetch the page, but it
  does read the image address out of the supplied document and retrieve that — an
  address this server never sees.

## [0.1.1] - 2026-08-18

### Fixed

- First release published through the automated pipeline, with npm provenance
  and the MCP registry entry. 0.1.0 had been published manually while setting
  up Trusted Publishing and therefore carries no provenance attestation.

## [0.1.0] - 2026-08-18

### Added

- Initial implementation: MCP server for [Mealie](https://mealie.io), the
  self-hosted recipe manager and meal planner.
- 52 tools — 17 read tools that are always registered, 35 write and import tools
  that are omitted when `MEALIE_READ_ONLY=true`: recipe search and detail, recipe
  CRUD, import from URL / HTML / schema.org JSON / photo, tags, categories and
  tools, foods, units and the ingredient parser, meal plans, shopping lists
  including recipe-to-list, cookbooks, ratings, comments, timeline entries and
  public share links.
- Confirmation tokens on the nine operations that delete, merge or widen access.
  Tokens are single-use, bound to the target, and for set operations bound to a
  fingerprint of the whole sorted id set.
- URL validation that restricts the import tools to public `http`/`https`
  addresses, because Mealie performs those fetches from inside its own network.
- All instance content is returned behind an explicit untrusted-content marker.

[0.1.2]: https://github.com/ni-c/mealie-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/ni-c/mealie-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/ni-c/mealie-mcp/releases/tag/v0.1.0

<!-- #endregion changelog -->
