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
untrusted-content marker, and confirmation prompts quote ids and counts only — never
a recipe name, tag or comment.

**Mealie performs the fetch, not this server.** `import_recipe_from_url`,
`preview_recipe_url` and the image import hand a URL or a payload to Mealie, which
retrieves it from inside its own network. URLs are therefore restricted to `http` and
`https` — zod's `.url()` accepts `file:`, `javascript:` and `data:` — and loopback,
private-range, link-local and `.lan`/`.internal`/`.local` hosts are refused, since no
recipe lives there. This is not a complete SSRF defence and cannot be: the name is
resolved by Mealie, and a public name can point at a private address. The real
boundary is Mealie's own network egress.

## Confirmation tokens

Deleting a recipe, organizer, cookbook, shopping list or comment, merging foods or
units, and creating a public share link all require a server-generated token that is
bound to the specific target and can be used once. A model cannot satisfy that gate
on its own, and a token issued for one target cannot be replayed against another —
for operations on a set of ids the token is bound to a fingerprint of the whole
sorted set, and for a merge to the direction as well.
