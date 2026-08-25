# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

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
