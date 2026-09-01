# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/mealie-mcp.git && cd mealie-mcp
npm install
npm test          # 292 unit tests, no network and no Mealie instance needed
npm run build
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change. CI
  runs lint, build and tests on Node 22 and 24, the integration suite against a
  real Mealie, plus `npm audit`, CodeQL with the `security-and-quality` query
  pack, and a Trivy scan of the container image on amd64 and arm64.
- **Comments** explain constraints the code cannot show — not what the next line
  does. Most comments in `src/` document a Mealie API behaviour that is not in the
  docs; keep that going.
- **Security-sensitive areas** (config parsing, confirmation tokens, `httpUrl`,
  anything that builds a request URL): please describe the attack you are defending
  against, or the one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and
  prettier also validates the YAML, JSON and Markdown files.

## Running the integration suite

The unit tests mock `fetch`, so they check that this server does what its author
believed Mealie does. The integration suite checks what Mealie does. It spawns
the built server over stdio against a throwaway Mealie in Docker and calls
**every tool in the catalogue** — the deletes and merges included, and both
halves of every confirmation — so the backend has to be one nobody wants:
`test/integration/compose.yml` binds to `127.0.0.1` only, and the harness
refuses any backend URL that is not on this machine.

```sh
npm run build     # the suite runs dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

`test/integration/bootstrap.ts` replaces the seven curl commands that used to
live in this file. Two things it knows that Mealie does not document:
`DEFAULT_EMAIL` and `DEFAULT_PASSWORD` are ignored — the seeded admin is always
`changeme@example.com` / `MyPassword` — and `POST /api/admin/users` wants the
group and household by **name**, not by UUID.

**One tool is not covered:** `import_recipe_from_url` needs outbound internet
from the Mealie container to scrape a public recipe site. Making every pull
request depend on a third party staying up, and on being polite to them, is not
worth it for a scraper that is Mealie's rather than this server's. It is
verified by hand:

```sh
# against a running sandbox, with MEALIE_URL and MEALIE_API_TOKEN set
npx @modelcontextprotocol/inspector node dist/index.js
# import_recipe_from_url { "url": "https://www.bbcgoodfood.com/recipes/classic-pancakes",
#                          "include_tags": true }
```

The suite says so out loud rather than quietly reporting full coverage: the
skip carries that reason, and if the tool is ever exercised the assertion fails
until the reason is removed.

CI runs the suite on every pull request against the pinned image, and weekly
against `ghcr.io/mealie-recipes/mealie:v3` — the first catches regressions here,
the second catches Mealie moving. It is deliberately not a gate on `publish`;
see the comment in `ci.yml`.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/mealie-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/mealie-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/mealie-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
