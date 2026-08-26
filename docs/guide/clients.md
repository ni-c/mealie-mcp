# Connecting clients

All examples use `https://mealie.example.com` — replace it with your own
instance URL and use a token from Mealie's **Settings → API Tokens**.

## Claude Code

```sh
claude mcp add mealie \
  -e MEALIE_URL=https://mealie.example.com \
  -e MEALIE_API_TOKEN=… \
  -- npx -y @ni-c/mealie-mcp
```

## Claude Desktop

Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mealie": {
      "command": "npx",
      "args": ["-y", "@ni-c/mealie-mcp"],
      "env": {
        "MEALIE_URL": "https://mealie.example.com",
        "MEALIE_API_TOKEN": "…"
      }
    }
  }
}
```

## Codex

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.mealie]
command = "npx"
args = ["-y", "@ni-c/mealie-mcp"]

[mcp_servers.mealie.env]
MEALIE_URL = "https://mealie.example.com"
MEALIE_API_TOKEN = "…"
```

## MCP Inspector

To poke at the tools interactively:

```sh
MEALIE_URL=https://mealie.example.com MEALIE_API_TOKEN=… \
  npx @modelcontextprotocol/inspector npx -y @ni-c/mealie-mcp
```

## Docker

The image on GHCR runs the same stdio server in a container:

```sh
docker run --rm -i \
  -e MEALIE_URL=https://mealie.example.com \
  -e MEALIE_API_TOKEN=… \
  ghcr.io/ni-c/mealie-mcp
```

For an MCP client config, use `docker` as the command:

```json
{
  "mcpServers": {
    "mealie": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "MEALIE_URL=https://mealie.example.com",
        "-e", "MEALIE_API_TOKEN=…",
        "ghcr.io/ni-c/mealie-mcp"
      ]
    }
  }
}
```

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) serves many stdio MCP servers from one container
behind a single HTTPS endpoint, so mealie-mcp can be reached from clients that cannot
spawn a local process — ChatGPT connectors, Claude on the web, Cursor — without a
container, a hostname and an OAuth stack of its own.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you
already have, with the hub's own filter alongside:

```json
{
  "mcpServers": {
    "mealie": {
      "command": "npx",
      "args": ["-y", "@ni-c/mealie-mcp"],
      "env": { "MEALIE_ALLOW_TOOLS": "essential" },
      "denyTools": ["delete_*"]
    }
  }
}
```

`allowTools` and `denyTools` are the hub's **own** per-server filter and take exact
tool names or `list_*` prefixes — the same syntax as the two environment variables,
so a list moves between them verbatim. What does **not** move is `essential`: that
preset is a mealie-mcp feature and belongs in `env` as shown.
`"allowTools": ["essential"]` would be a name the hub cannot resolve.

The two compose, and it is worth knowing which does what: the server registers what
its environment variables allow, and the hub exposes what its arrays allow.
Filtering in the server is the tighter of the two — the tool is never built.

Register `https://your-host/mealie/mcp` as a connector and you
get this server alone. Register the hub's `/hub` endpoint instead and you reach
_every_ server behind it through six meta-tools, which is the answer worth having
once you run several of these at once.
