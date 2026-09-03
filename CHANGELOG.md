# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [0.3.0] - 2026-09-03

### Added

- Every tool declares an `outputSchema` and answers with `structuredContent`
  beside the text block. A client no longer has to parse prose to use a result —
  which nine of them made unavoidable, since they answered with a sentence. The
  sentence stays, in the text block.

  Most tools carry `untrusted: true` and `source: "mealie"` as fields, not only
  as a preamble in the text: recipes are routinely scraped from arbitrary
  websites and comments come from other users of the instance. The ten without
  the marker answer with an id this server was given, or — for `get_about` — a
  version string and the permission flags of the account it authenticates as.

  Mealie's records are described as open objects with the top-level keys this
  server builds. A self-hosted Mealie is any release, and a strict shape would
  turn a field one adds into a tool that fails outright.

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

### Changed

- The advertised schemas avoid spellings that are legal JSON Schema and still
  get a tool refused, or its constraint silently dropped, by some MCP clients:
  an open object now writes `"additionalProperties": true` rather than the
  empty schema `{}` zod emits for it; and a nullable field is written as
  `anyOf` branches rather than `"type": ["string", "null"]`, which several
  clients read as a single type and then drop. What the tools accept and return
  is unchanged; only the way the schema says so is.

- A result too large to shrink is now an error rather than an envelope carrying
  the oversized document as a string. That envelope is valid JSON and no longer
  a valid _answer_: the SDK checks a result against the schema its tool
  declares.

- `update_recipe` with no fields answers `{recipe, changed: false, note}` rather
  than the bare sentence. It is still not an error — a model that resolved every
  field to its current value should not be punished for asking.

- The two-call `confirm_token` prompt is an error result. What was asked for did
  not happen, which is what `isError` says. The text is unchanged and still
  carries the token.

- `MEALIE_READ_ONLY` now accepts `1`, `true` and `yes` in any case and ignores
  surrounding whitespace, matching the rest of the family. It only ever takes
  capability away, so an operator who wrote `MEALIE_READ_ONLY=True` meant the safe
  thing and now gets it — where before that spelling silently left every write tool
  registered. `MEALIE_INSECURE_TLS` stays exactly `true` on purpose: it weakens the
  server, so only the one unambiguous spelling should do it.

- The shared libraries move to `mcp-approval` 0.7.1, `mcp-tool-allowlist` 0.2.1,
  `mcp-internal-hosts` 0.2.1, `mcp-integration-harness` 0.2.0 and `svg-asset-set`
  0.2.0.

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

- stdio is served through `serveStdio`, so the connection's era is negotiated
  on the opening exchange rather than assumed. A client that pins the
  `2026-07-28` era is served it; until now its `server/discover` probe was
  answered with "Method not found" and only `2025-11-25` was on offer. A client
  that speaks the older era sees no change — it is still pinned to one instance
  for the life of the connection, exactly as a hand-wired
  `StdioServerTransport` served it.

### Fixed

- **`search_recipes` answered a narrowed question with the whole collection.**
  The tool described `tags`, `categories` and `tools` as taking "names, slugs or
  UUIDs". Mealie takes no names: `_uuids_for_items` looks a non-UUID up as a slug,
  returns an empty list when nothing matches, and `_build_recipe_filter` then
  tests `if tags:` — so the filter is not attached at all. Measured on v3.22.0
  with three recipes, one tagged "Weeknight Dinner":
  `?tags=Weeknight%20Dinner` returned all three, as did the mistyped slug
  `weeknight-dinnerrr`, with nothing in the answer saying it had not been
  filtered. Names and slugs are now resolved to ids before the search runs, and
  an entry that resolves to nothing is an error.

- **`search_recipes` promised AND and did not deliver it.** `cookbook` and the
  organizer filters are mutually exclusive in Mealie — `_build_recipe_filter`
  returns the cookbook's own filter and returns early — so
  `{cookbook: "desserts", tags: ["vegan"]}` silently ignored the tags. Confirmed
  live. The combination is now refused.

- **`search_recipes({foods: […]})` could only 500.** Mealie resolves foods not at
  all and puts the value straight into `RecipeIngredientModel.food_id == food`, so
  a name or slug reaches the `GUID` type decorator and comes back as HTTP 500.
  `foods` now takes UUIDs only, as `suggest_recipes` always has.

- **`order_by: "random"` always failed.** Mealie's pagination model validates
  `paginationSeed is required when orderBy is random` and answers HTTP 422; the
  tool took no seed, so the option could not be used. It now generates one per
  call.

- Mealie's organizer slug routes answer "no such slug" two different ways —
  `/categories/slug/nope` is a clean 404 while `/tags/slug/nope` and
  `/tools/slug/nope` are HTTP 500. The lookup reads both as a miss and falls
  through to the name search; a Mealie that is genuinely failing still reports
  the failure, because that second request has to succeed for anything to
  resolve. Found by the integration suite, not by reading.

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

- Confirmation tokens are compared with a **constant-time** comparison. The
  copy in this repository used `!==`, which leaks through timing how much of a
  guess was right. Reaching a token still requires having received it in a
  previous tool result, so this closes a margin rather than a hole.

- An entry in `MEALIE_ALLOW_TOOLS` that is not tool-name-shaped is now
  **redacted** in the error rather than quoted back. `MEALIE_TOKEN` and
  `MEALIE_ALLOW_TOOLS` are adjacent lines in every compose file, and a paste
  into the wrong one used to print the credential into the client's log.

### Security

- **The confirmation gate was drawn along the wrong line.** It followed the tool
  _name_ — everything called `delete_*` or `merge_*` asked — rather than "cannot
  be undone", and four tools fell in the gap. `update_recipe` with
  `{ingredients: [], instructions: []}` emptied a recipe in one call and answered
  with the now-empty recipe, where `delete_recipe` on the same recipe cost two
  calls and a token; Mealie keeps no version history, so both are equally final.
  `update_organizer`, `update_mealplan_entry` and `update_shopping_list_items`
  were the other three.

  The line is now the one `annotations.ts` always stated — content a person
  wrote, replaced with no way back — applied per _call_ rather than per tool.
  `update_recipe` asks when it replaces name, description, ingredients,
  instructions, tags, categories or notes, and goes straight through for times,
  servings, yield and the source link. `update_shopping_list_items` asks for
  `note` and not for ticking off. `update_mealplan_entry` asks for `title` and
  `text` and not for a move. `update_organizer` always asks: a rename
  regenerates the slug. Each approval is bound to a fingerprint of the replacing
  values as well as to the target, so one shown for one new instruction list
  cannot be spent on a call that clears the list instead.

  The lasting part is `test/gating.test.ts`, which claims this over the whole
  catalogue: every tool annotated `destructiveHint: true` has to accept a
  `confirm_token`, has to write nothing on its first call, and has to appear in
  that file's table. A per-tool test would not have found the gap — every
  per-tool test that existed passed.

- **`create_cookbook(is_public: true)` published without asking.** The one other
  tool that widens who can see something; `create_share_token` has been guarded
  since it existed. It exposes less than a share link — the recipes themselves
  need `settings.public` of their own — but the name, description and saved
  filter go out, and there is no `update_cookbook` to take it back with. A
  private cookbook is still created without a prompt.

- **`import_recipe_from_html_or_json` claimed `openWorldHint: false`** while
  Mealie fetched an address out of the document it was handed. Verified against
  v3.22.0: a pasted `{"image": "http://…/latest/meta-data/"}` puts `Image URL: …`
  in Mealie's log and goes through `recipe_data_service.scrape_image`. Mealie's
  own guard refuses on `is_private`, which is False for `100.100.100.200`
  (Alibaba Cloud metadata) and for all of `100.64.0.0/10`. The tool now carries
  `openWorldHint: true`, and the addresses this server can find in the document —
  schema.org `image`/`thumbnailUrl`/`contentUrl` in all three shapes, `<img src>`,
  `og:image` — go through the same `assertFetchableUrl` as a URL argument.

- **`source_url` was the only URL argument with no scheme check.** `httpUrl`
  exists because zod's `.url()` accepts `javascript:`, `file:` and `data:`;
  `source_url` was a plain string, Mealie does not validate `org_url` either, and
  the value comes back to every reader through `recipeDetail`. It is now
  `httpUrl`.

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

[0.3.0]: https://github.com/ni-c/mealie-mcp/releases/tag/v0.3.0
[0.1.2]: https://github.com/ni-c/mealie-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/ni-c/mealie-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/ni-c/mealie-mcp/releases/tag/v0.1.0

<!-- #endregion changelog -->
