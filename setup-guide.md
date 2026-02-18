# ⚡ Selenium MCP Quick Start – 5 Minutes to Your First Browser Automation

Get a local Selenium WebDriver MCP server running and usable from Claude Desktop.

## Prerequisites (≈30s)

✅ Docker Desktop installed & running (Beta features available)  
✅ Claude Desktop installed  
✅ Windows PowerShell (or macOS/Linux shell)  
✅ (Optional) Chrome/Firefox locally if you want to run without Docker

## Step 1: Enable Docker MCP Toolkit (≈1m)
1. Open Docker Desktop
2. Settings → Beta Features
3. Enable: "Docker MCP Toolkit"
4. Apply & Restart

## Step 2: Build the Selenium MCP Image (≈1–2m)
From the repo root (where this folder lives):

```powershell
# Windows PowerShell
cd "$PSScriptRoot"  # If already in repo root skip
# Build the local image (tag must match catalog file: mcp-selenium:local)
docker build -t mcp-selenium:local .\angiejones_mcp-selenium
```

```bash
# macOS / Linux
cd path/to/repo
docker build -t mcp-selenium:local ./angiejones_mcp-selenium
```

Verify:
```powershell
docker images | Select-String mcp-selenium
```

## Step 3: Install Catalog & Registry Entries (≈1m)
The repository already includes `selenium-mcp.yaml` at the root which declares the server. You need it under Docker MCP catalogs plus a registry reference.

Automatic (Windows):
```powershell
./scripts/setup_selenium_mcp.ps1
```

Manual:
```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE/.docker/mcp/catalogs" | Out-Null
Copy-Item ./selenium-mcp.yaml "$env:USERPROFILE/.docker/mcp/catalogs/selenium-mcp.yaml"

# Ensure registry exists
if (!(Test-Path "$env:USERPROFILE/.docker/mcp/registry.yaml")) { "version: 2`n" | Out-File "$env:USERPROFILE/.docker/mcp/registry.yaml" -Encoding utf8 }

# Append (idempotent check recommended)
$symbol = '  mcp-selenium:'
$regPath = "$env:USERPROFILE/.docker/mcp/registry.yaml"
if (-not (Get-Content $regPath | Select-String $symbol)) {
  Add-Content $regPath "  mcp-selenium:"; Add-Content $regPath "    ref: \"\"" }
```

macOS/Linux manual equivalent:
```bash
mkdir -p ~/.docker/mcp/catalogs
cp ./selenium-mcp.yaml ~/.docker/mcp/catalogs/selenium-mcp.yaml
if [ ! -f ~/.docker/mcp/registry.yaml ]; then echo "version: 2" > ~/.docker/mcp/registry.yaml; fi
grep -q "mcp-selenium:" ~/.docker/mcp/registry.yaml || { 
  echo "  mcp-selenium:" >> ~/.docker/mcp/registry.yaml; 
  echo "    ref: \"\"" >> ~/.docker/mcp/registry.yaml; }
```

## Step 4: Configure Claude Desktop (≈1m)
Add an entry so Claude can launch the gateway which exposes the Selenium server via catalogs.

Windows:
```powershell
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

macOS:
```bash
nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Add (or merge) into the root JSON object:
```json
{
  "mcpServers": {
    "mcp-toolkit-gateway": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", "C:/Users/[YOUR_USERNAME]/.docker/mcp:/mcp",   // Windows (escape backslashes if needed)
        "docker/mcp-gateway",
        "--catalog=/mcp/catalogs/docker-mcp.yaml",
        "--catalog=/mcp/catalogs/selenium-mcp.yaml",
        "--config=/mcp/config.yaml",
        "--registry=/mcp/registry.yaml",
        "--tools-config=/mcp/tools.yaml",
        "--transport=stdio"
      ]
    }
  }
}
```
macOS path example to replace the bind mount:
```
"-v", "/Users/yourname/.docker/mcp:/mcp",
```

## Step 5: Restart & Test (≈30s)
1. Fully quit and reopen Claude Desktop
2. New chat → Tools icon (Ctrl/Cmd + I)
3. You should see `mcp-toolkit-gateway` and within it `Local Selenium` tools
4. Try prompts:
   - "Start a headless Chrome browser"
   - "Navigate the Selenium browser to https://example.com and get the page title"
   - "Find an element by css 'h1' and get its text"

Example tool calls Claude might orchestrate:
```json
{"tool":"start_browser","args":{"browser":"chrome","options":{"headless":true}}}
{"tool":"navigate","args":{"url":"https://example.com"}}
{"tool":"find_element","args":{"by":"css","value":"h1"}}
{"tool":"get_element_text","args":{"by":"css","value":"h1"}}
```

## Optional: Run Without Docker
For quick local dev (installs Node deps locally):
```powershell
cd .\angiejones_mcp-selenium
npm install
node src/lib/server.js --transport=stdio
```
Then create an alternate Claude config entry pointing directly to `node` + args (skipping gateway) if desired.

A helper script is provided:
```powershell
./scripts/run_selenium_mcp.ps1
```

## Troubleshooting
| Issue | Check |
|-------|-------|
| Tools not listed | Gateway running? Catalog file copied? Registry entry appended? |
| Image missing | Re-run build; confirm `docker images` shows `mcp-selenium` |
| Browser start timeout | First run downloads drivers; rerun `start_browser` |
| Permissions (Mac) | Docker full disk access / Security & Privacy allowances |
| Headless artifacts differ | Some sites block headless; try non-headless (`headless:false`) |

Claude Logs: Help → Show Logs.  
Gateway Logs: Add `"--log-level=debug"` after gateway args for verbose output.

## Next Steps
- Add more tools (e.g., screenshot, execute_script) to `src/lib/server.js`
- Contribute enhancements (page waits, performance metrics)
- Secure usage: isolate browsing via a disposable container profile

---
🙌 You now have Selenium browser automation accessible through MCP!
