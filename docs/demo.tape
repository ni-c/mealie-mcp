# vhs script for the demo GIF: `cd docs && vhs demo.tape` writes public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * the server installed: npm install -g @ni-c/mealie-mcp
#     (the inspector CLI mis-parses an `npx -y <pkg>` target, so the tape calls
#     the installed binary directly)
#   * a reachable Mealie instance, with MEALIE_URL and MEALIE_API_TOKEN exported
#     in the shell that runs vhs — the commands reference the variables, so the
#     token never appears in the recording
#
# Rules learned the hard way:
#   * inside Hide blocks use vhs's own `Sleep`, never the shell's — shell sleep
#     blocks and the tape ends before any output is recorded
#   * pass the server's environment through the inspector's `-e` flags; the
#     inspector spawns the target with a clean environment
#   * start from the running server, do not record the setup

Output public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "clear" Enter
Sleep 500ms
Show

Type "# mealie-mcp — MCP server for the Mealie recipe manager" Enter
Sleep 1s
Type "# list the 52 tools it exposes" Enter
Sleep 500ms
Type "npx -y @modelcontextprotocol/inspector --cli mealie-mcp -e MEALIE_URL=$MEALIE_URL -e MEALIE_API_TOKEN=$MEALIE_API_TOKEN --method tools/list | jq -r '.tools[].name' | head -14" Enter
Sleep 7s
Type "clear" Enter
Type "# search the recipe collection" Enter
Sleep 500ms
Type "npx -y @modelcontextprotocol/inspector --cli mealie-mcp -e MEALIE_URL=$MEALIE_URL -e MEALIE_API_TOKEN=$MEALIE_API_TOKEN --method tools/call --tool-name search_recipes --tool-arg search=curry | jq -r '.content[0].text' | tail -n +3 | head -18" Enter
Sleep 8s
