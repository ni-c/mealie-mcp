# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/mealie-mcp.git && cd mealie-mcp
npm install
npm test          # 239 unit tests, no network and no Mealie instance needed
npm run build
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change. CI
  runs lint, build and tests on Node 22 and 24, plus `npm audit`, CodeQL with the
  `security-and-quality` query pack, and a Trivy scan of the container image on
  amd64 and arm64.
- **Comments** explain constraints the code cannot show — not what the next line
  does. Most comments in `src/` document a Mealie API behaviour that is not in the
  docs; keep that going.
- **Security-sensitive areas** (config parsing, confirmation tokens, `httpUrl`,
  anything that builds a request URL): please describe the attack you are defending
  against, or the one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both eslint and prettier, and
  prettier also validates the YAML, JSON and Markdown files.

## Verifying against a real Mealie

The unit tests mock `fetch`, so they cannot catch a change in Mealie's own
behaviour. `scripts/verify-live.mjs` exercises **every** tool against a running
instance, including the deletes and both halves of every confirmation flow.

**Never point it at an instance whose recipes matter.** Use a disposable one:

```sh
mkdir -p /tmp/mealie-test/data
cat > /tmp/mealie-test/compose.yml <<'YAML'
services:
  mealie-test:
    image: ghcr.io/mealie-recipes/mealie:v3.22.0   # match your real instance
    ports: ['127.0.0.1:9930:9000']
    environment:
      ALLOW_SIGNUP: 'false'
      PUID: '1000'
      PGID: '1000'
      BASE_URL: http://localhost:9930
    volumes: ['/tmp/mealie-test/data:/app/data']
YAML
docker compose -f /tmp/mealie-test/compose.yml up -d
```

Mealie seeds a default admin on first start and **ignores `DEFAULT_EMAIL` /
`DEFAULT_PASSWORD`** — log in as `changeme@example.com` / `MyPassword`.

Create a non-admin user to mirror a sensible deployment, then mint its token. Note
that `POST /api/admin/users` wants the group and household by **name**, not by UUID:

```sh
B=http://127.0.0.1:9930
ADMIN=$(curl -s -X POST "$B/api/auth/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode username=changeme@example.com \
  --data-urlencode password=MyPassword | jq -r .access_token)

curl -s -X POST "$B/api/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{
    "username":"cook","fullName":"Cook","email":"cook@example.com",
    "password":"MyPassword","admin":false,"group":"Home","household":"Family",
    "canOrganize":true,"canManage":false,"canInvite":false,"advanced":true}'

COOK=$(curl -s -X POST "$B/api/auth/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode username=cook@example.com \
  --data-urlencode password=MyPassword | jq -r .access_token)

TOKEN=$(curl -s -X POST "$B/api/users/api-tokens" -H "Authorization: Bearer $COOK" \
  -H 'Content-Type: application/json' -d '{"name":"verify"}' | jq -r .token)
```

Then:

```sh
npm run build
MEALIE_URL=$B MEALIE_API_TOKEN=$TOKEN node scripts/verify-live.mjs
```

It prints one line per call, reports any tool it did not reach, and exits non-zero
if any call produced an unexpected outcome. Two of its checks need real outbound
internet from the Mealie container, because they import a recipe from a public
site. Tear the instance down afterwards:

```sh
docker compose -f /tmp/mealie-test/compose.yml down -v && rm -rf /tmp/mealie-test
```

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/mealie-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/mealie-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/mealie-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
