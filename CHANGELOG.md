# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

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

[0.1.1]: https://github.com/ni-c/mealie-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/ni-c/mealie-mcp/releases/tag/v0.1.0

<!-- #endregion changelog -->
