[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/angiejones-mcp-selenium-badge.png)](https://mseep.ai/app/angiejones-mcp-selenium)

# MCP Selenium Server

<a href="https://glama.ai/mcp/servers/s2em7b2kwf">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/s2em7b2kwf/badge" />
</a>

[![smithery badge](https://smithery.ai/badge/@angiejones/mcp-selenium)](https://smithery.ai/server/@angiejones/mcp-selenium)

A Model Context Protocol (MCP) server implementation for Selenium WebDriver, enabling browser automation through standardized MCP clients.

## Video Demo (Click to Watch)

[![Watch the video](https://img.youtube.com/vi/mRV0N8hcgYA/sddefault.jpg)](https://youtu.be/mRV0N8hcgYA)


## Features

- Start browser sessions with customizable options
- Navigate to URLs
- Find elements using various locator strategies
- Click, type, and interact with elements
- Perform mouse actions (hover, drag and drop)
- Handle keyboard input
- Take screenshots
- Upload files
- Support for headless mode

## Supported Browsers

- Chrome
- Firefox
- MS Edge

## Use with Goose

### Option 1: One-click install
Copy and paste the link below into a browser address bar to add this extension to goose desktop:

```
goose://extension?cmd=npx&arg=-y&arg=%40angiejones%2Fmcp-selenium&id=selenium-mcp&name=Selenium%20MCP&description=automates%20browser%20interactions
```


### Option 2: Add manually to desktop or CLI

* Name: `Selenium MCP`
* Description: `automates browser interactions`
* Command: `npx -y @angiejones/mcp-selenium`

## Use with other MCP clients (e.g. Claude Desktop, etc)
```json
{
  "mcpServers": {
    "selenium": {
      "command": "npx",
      "args": ["-y", "@angiejones/mcp-selenium"]
    }
  }
}
```

---

## Development

To work on this project:

1. Clone the repository
2. Install dependencies: `npm install`
3. Run the server: `npm start`

### Code Structure

```
src/lib/
├── server.js          # MAIN - Handles BOTH stdio AND HTTP transport
│                      # This is what docker-entrypoint.sh runs
│                      # Contains all Selenium WebDriver logic
│
├── selenium-server.js # UNUSED by main server - legacy/alternative implementation
│                      # Do NOT modify this expecting changes in production
│
└── http-server.js     # UNUSED by main server - legacy/alternative implementation
                       # Do NOT modify this expecting changes in production
```

**Important:** All browser automation code is in `server.js`. The other files exist but are NOT used by the Docker entrypoint.

### Installation

#### Installing via Smithery

To install MCP Selenium for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@angiejones/mcp-selenium):

```bash
npx -y @smithery/cli install @angiejones/mcp-selenium --client claude
```

#### Manual Installation
```bash
npm install -g @angiejones/mcp-selenium
```


### Usage

Start the server by running:

```bash
mcp-selenium
```

Or use with NPX in your MCP configuration:

```json
{
  "mcpServers": {
    "selenium": {
      "command": "npx",
      "args": [
        "-y",
        "@angiejones/mcp-selenium"
      ]
    }
  }
}
```



## Tools

### start_browser
Launches a browser session.

**Parameters:**
- `browser` (required): Browser to launch
  - Type: string
  - Enum: ["chrome", "firefox"]
- `options`: Browser configuration options
  - Type: object
  - Properties:
    - `headless`: Run browser in headless mode
      - Type: boolean
    - `arguments`: Additional browser arguments
      - Type: array of strings

**Example:**
```json
{
  "tool": "start_browser",
  "parameters": {
    "browser": "chrome",
    "options": {
      "headless": true,
      "arguments": ["--no-sandbox"]
    }
  }
}
```

### navigate
Navigates to a URL.

**Parameters:**
- `url` (required): URL to navigate to
  - Type: string

**Example:**
```json
{
  "tool": "navigate",
  "parameters": {
    "url": "https://www.example.com"
  }
}
```

### find_element
Finds an element on the page.

**Parameters:**
- `by` (required): Locator strategy
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `value` (required): Value for the locator strategy
  - Type: string
- `timeout`: Maximum time to wait for element in milliseconds
  - Type: number
  - Default: 10000

**Example:**
```json
{
  "tool": "find_element",
  "parameters": {
    "by": "id",
    "value": "search-input",
    "timeout": 5000
  }
}
```

### click_element
Clicks an element.

**Parameters:**
- `by` (required): Locator strategy
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `value` (required): Value for the locator strategy
  - Type: string
- `timeout`: Maximum time to wait for element in milliseconds
  - Type: number
  - Default: 10000

**Example:**
```json
{
  "tool": "click_element",
  "parameters": {
    "by": "css",
    "value": ".submit-button"
  }
}
```

### send_keys
Sends keys to an element (typing).

**Parameters:**
- `by` (required): Locator strategy
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `value` (required): Value for the locator strategy
  - Type: string
- `text` (required): Text to enter into the element
  - Type: string
- `timeout`: Maximum time to wait for element in milliseconds
  - Type: number
  - Default: 10000

**Example:**
```json
{
  "tool": "send_keys",
  "parameters": {
    "by": "name",
    "value": "username",
    "text": "testuser"
  }
}
```

### get_element_text
Gets the text() of an element.

**Parameters:**
- `by` (required): Locator strategy
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `value` (required): Value for the locator strategy
  - Type: string
- `timeout`: Maximum time to wait for element in milliseconds
  - Type: number
  - Default: 10000

**Example:**
```json
{
  "tool": "get_element_text",
  "parameters": {
    "by": "css",
    "value": ".message"
  }
}
```

### hover
Moves the mouse to hover over an element.

**Parameters:**
- `by` (required): Locator strategy
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `value` (required): Value for the locator strategy
  - Type: string
- `timeout`: Maximum time to wait for element in milliseconds
  - Type: number
  - Default: 10000

**Example:**
```json
{
  "tool": "hover",
  "parameters": {
    "by": "css",
    "value": ".dropdown-menu"
  }
}
```

### drag_and_drop
Drags an element and drops it onto another element.

**Parameters:**
- `by` (required): Locator strategy for source element
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `value` (required): Value for the source locator strategy
  - Type: string
- `targetBy` (required): Locator strategy for target element
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `targetValue` (required): Value for the target locator strategy
  - Type: string
- `timeout`: Maximum time to wait for elements in milliseconds
  - Type: number
  - Default: 10000

**Example:**
```json
{
  "tool": "drag_and_drop",
  "parameters": {
    "by": "id",
    "value": "draggable",
    "targetBy": "id",
    "targetValue": "droppable"
  }
}
```

### double_click
Performs a double click on an element.

**Parameters:**
- `by` (required): Locator strategy
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `value` (required): Value for the locator strategy
  - Type: string
- `timeout`: Maximum time to wait for element in milliseconds
  - Type: number
  - Default: 10000

**Example:**
```json
{
  "tool": "double_click",
  "parameters": {
    "by": "css",
    "value": ".editable-text"
  }
}
```

### right_click
Performs a right click (context click) on an element.

**Parameters:**
- `by` (required): Locator strategy
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `value` (required): Value for the locator strategy
  - Type: string
- `timeout`: Maximum time to wait for element in milliseconds
  - Type: number
  - Default: 10000

**Example:**
```json
{
  "tool": "right_click",
  "parameters": {
    "by": "css",
    "value": ".context-menu-trigger"
  }
}
```

### press_key
Simulates pressing a keyboard key.

**Parameters:**
- `key` (required): Key to press (e.g., 'Enter', 'Tab', 'a', etc.)
  - Type: string

**Example:**
```json
{
  "tool": "press_key",
  "parameters": {
    "key": "Enter"
  }
}
```

### upload_file
Uploads a file using a file input element.

**Parameters:**
- `by` (required): Locator strategy
  - Type: string
  - Enum: ["id", "css", "xpath", "name", "tag", "class"]
- `value` (required): Value for the locator strategy
  - Type: string
- `filePath` (required): Absolute path to the file to upload
  - Type: string
- `timeout`: Maximum time to wait for element in milliseconds
  - Type: number
  - Default: 10000

**Example:**
```json
{
  "tool": "upload_file",
  "parameters": {
    "by": "id",
    "value": "file-input",
    "filePath": "/path/to/file.pdf"
  }
}
```

### take_screenshot
Captures a screenshot of the current page.

**Parameters:**
- `outputPath` (optional): Path where to save the screenshot. If not provided, returns base64 data.
  - Type: string

**Example:**
```json
{
  "tool": "take_screenshot",
  "parameters": {
    "outputPath": "/path/to/screenshot.png"
  }
}
```

### close_session
Closes the current browser session and cleans up resources.

**Parameters:**
None required

**Example:**
```json
{
  "tool": "close_session",
  "parameters": {}
}
```


---

## Airlocked Agent Integration

This fork includes modifications for running Selenium MCP inside the [airlocked-agent](https://github.com/your-repo/airlocked-agent) containerized environment with proxy security and localhost OAuth support.

### Key Modifications

1. **HTTP Transport Mode**: Runs as an HTTP server (`--http` flag) instead of stdio for container-to-container communication
2. **Proxy Configuration**: Automatically configures Firefox to use Squid proxy for whitelisted traffic
3. **Localhost Forwarding**: socat-based forwarding enables OAuth callbacks to `localhost:8000`
4. **Cross-Session State**: `/state/mcp-state.json` for sharing known issues between Claude sessions

### Running in Airlocked Agent

```yaml
# docker-compose.airlocked.yml
selenium-mcp:
  image: selenium-mcp:latest
  container_name: airlocked_selenium
  environment:
    MCP_TRANSPORT: "http"
    ENABLE_LOCALHOST_FORWARD: "true"  # For OAuth callbacks
    HTTP_PROXY: http://proxy:3128
    HTTPS_PROXY: http://proxy:3128
  extra_hosts:
    - "host.docker.internal:host-gateway"
  networks:
    - airlocked_net
  cap_add:
    - SYS_CHROOT  # Required for Firefox sandbox
```

### Browser Support in Airlocked

| Browser | General Browsing | localhost:8000 (OAuth) |
|---------|-----------------|------------------------|
| Firefox | ✅ Via proxy | ✅ Via socat |
| Chrome  | ✅ Via proxy | ❌ Hardcoded bypass |

**Use Firefox for OAuth E2E testing.**

### MCP State File

The server maintains state at `/state/mcp-state.json` for cross-session communication:

```json
{
  "knownIssues": [...],
  "workingPatterns": [...],
  "notes": [...],
  "recentErrors": [...]
}
```

Query via the `get_mcp_status` tool or `mcp-status://current` resource.

---

## IMPORTANT: Host vs Container - Two Separate Instances

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HOST MACHINE                                         │
│                                                                              │
│  ┌──────────────────────────────────┐                                        │
│  │  Claude Code (host)              │                                        │
│  │                                  │                                        │
│  │  Uses: stdio selenium-mcp        │──── Spawns own process ────┐           │
│  │  Browser: Runs on HOST           │                            │           │
│  │  localhost:8000: Direct access   │                            ▼           │
│  └──────────────────────────────────┘                   ┌─────────────────┐  │
│                                                         │ selenium-mcp    │  │
│                                                         │ (host process)  │  │
│                                                         │ Browser: Chrome │  │
│                                                         │ /Firefox on host│  │
│  ┌─────────────────────────────────────────────────┐    └─────────────────┘  │
│  │              Docker Network                      │                        │
│  │                                                  │                        │
│  │  ┌─────────────────┐    ┌─────────────────────┐  │                        │
│  │  │ airlocked_agent │    │ airlocked_selenium  │  │                        │
│  │  │                 │    │                     │  │                        │
│  │  │ Uses: HTTP to   │───▶│ Browser: Firefox    │  │                        │
│  │  │ selenium:3000   │    │ in container        │  │                        │
│  │  │                 │    │                     │  │                        │
│  │  └─────────────────┘    │ localhost:8000 ─────┼──┼───▶ socat ──▶ host app │
│  │                         │ (via socat)         │  │                        │
│  │                         └─────────────────────┘  │                        │
│  └─────────────────────────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key Points:**
- **Host Claude Code** spawns its own selenium-mcp process (stdio). Browser runs on host, can access localhost directly.
- **airlocked_agent** connects to airlocked_selenium container (HTTP). Browser runs in container, needs socat to reach host's localhost.
- **They do NOT share browsers.** Starting a browser from host Claude Code does not affect airlocked_selenium.
- **mcp-state.json is shared** (volume mount), which can be confusing - errors from both instances appear there.

---

## Using from Host Machine (Claude Code)

When running Claude Code on your host machine (not inside a container), you have two options:

### Option 1: stdio Transport (Default, Ephemeral)

Uses `docker run --rm` to spawn a fresh container for each session:

```json
{
  "mcpServers": {
    "selenium": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--shm-size=2g",
        "selenium-mcp:latest"
      ]
    }
  }
}
```

**Pros**: Clean environment each time, no persistent state
**Cons**: Can't access airlocked network, no proxy enforcement

### Option 2: HTTP Transport (Persistent, Shared)

Connect to a running container (e.g., `airlocked_selenium`) via HTTP:

```json
{
  "mcpServers": {
    "selenium": {
      "url": "http://localhost:3001/mcp",
      "transport": "http"
    }
  }
}
```

This requires exposing the port in docker-compose:
```yaml
selenium-mcp:
  ports:
    - "3001:3000"
```

**Pros**: Shares state with airlocked agent, proxy enforced, persistent browser sessions
**Cons**: Requires container to be running, shared state between host and container Claude instances

### Which to Use?

| Use Case | Recommended |
|----------|-------------|
| Quick browser automation from host | stdio (Option 1) |
| E2E testing with airlocked security | HTTP to airlocked_selenium (Option 2) |
| OAuth flow testing | HTTP with `ENABLE_LOCALHOST_FORWARD=true` |
| Debugging container selenium issues | HTTP (same instance as agent) |

---

## License

MIT
