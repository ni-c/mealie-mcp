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
