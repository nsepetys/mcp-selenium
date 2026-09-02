# OOM Resilience Fixes

Two independent fixes. Implement in either order — they don't interact.

---

## Fix 1 — Add Docker healthchecks to dynamic workers

**File:** `autoscaler/index.js`  
**Lines:** 44–58 (the `cmd` array inside `startWorker()`)

**Problem:** `startWorker()` builds a `docker run` command without `--health-*` flags, so dynamic workers (selenium-3 through selenium-10) have no Docker healthcheck. Permanent workers in `docker-compose.fleet.yml` (selenium-1, selenium-2) DO have healthchecks. This inconsistency means HAProxy must rely solely on its own HTTP checks for dynamic workers instead of also tracking Docker health state.

**Current code (`startWorker`, lines 44–58):**
```javascript
const cmd = [
    'docker run -d',
    `--name ${containerName}`,
    `--hostname ${name}`,
    `--network ${NETWORK}`,
    `--network-alias ${name}`,
    `--memory ${WORKER_MEMORY}`,
    `--memory-swap ${WORKER_MEMORY_SWAP}`,
    '--shm-size 512m',
    '-e MCP_TRANSPORT=http',
    '-e MCP_PORT=3000',
    '-e LOCALHOST_FORWARD_PORTS=""',
    `-v ${VOLUME}:/data`,
    IMAGE,
].join(' ');
```

**Required change:** Add these five lines before the final `IMAGE` line:
```javascript
const cmd = [
    'docker run -d',
    `--name ${containerName}`,
    `--hostname ${name}`,
    `--network ${NETWORK}`,
    `--network-alias ${name}`,
    `--memory ${WORKER_MEMORY}`,
    `--memory-swap ${WORKER_MEMORY_SWAP}`,
    '--shm-size 512m',
    '-e MCP_TRANSPORT=http',
    '-e MCP_PORT=3000',
    '-e LOCALHOST_FORWARD_PORTS=""',
    `-v ${VOLUME}:/data`,
    '--health-cmd "curl -sf http://localhost:3000/health || exit 1"',
    '--health-interval 10s',
    '--health-timeout 5s',
    '--health-retries 5',
    '--health-start-period 15s',
    IMAGE,
].join(' ');
```

**Verify:** The flags must match the healthcheck config in `docker-compose.fleet.yml` (selenium-1/selenium-2 services, lines 64–69).

---

## Fix 2 — Server-side session auto-recovery after OOM restart

**File:** `src/lib/server.js`  
**Problem:** When a container OOM-kills and restarts, `state.drivers` (a Map) is wiped. Any tool call that calls `getDriver()` throws `'No active browser session'`. Agents then get stuck or escalate instead of recovering. The fix makes `getDriver()` async with auto-recovery: if no session exists, it auto-starts Chrome headless before returning the driver, transparent to the agent.

### Step 1 — Extract browser startup into a reusable function

Find the `start_browser` tool registration (line 224). The handler starts at line 231 (`async ({ browser, options = {} }) => {`) and ends at line 652.

Extract the handler body into a named `async function startBrowserInternal(browser, options = {})` placed **before** the `start_browser` tool registration. The function body is identical to the current handler body. Then update the `server.tool` call to use this extracted function:

```javascript
async function startBrowserInternal(browser, options = {}) {
    // --- paste the ENTIRE handler body from lines 232–651 here verbatim ---
}

server.tool(
    "start_browser",
    "launches browser",
    {
        browser: z.enum(["chrome", "firefox", "edge"]).describe("Browser to launch (chrome or firefox or microsoft edge)"),
        options: browserOptionsSchema
    },
    ({ browser, options = {} }) => startBrowserInternal(browser, options)
);
```

### Step 2 — Make `getDriver()` async with auto-recovery

**Current code (lines 158–166):**
```javascript
const getDriver = () => {
    const key = getDriverKey();
    const driver = key ? state.drivers.get(key) : null;
    if (!driver) {
        throw new Error('No active browser session');
    }
    return driver;
};
```

**Replace with:**
```javascript
const getDriver = async () => {
    const key = getDriverKey();
    let driver = key ? state.drivers.get(key) : null;
    if (!driver) {
        debugLog(`Auto-recovering: no browser session for key=${key}, starting Chrome headless`);
        try {
            await startBrowserInternal('chrome', {});
            driver = key ? state.drivers.get(key) : null;
        } catch (recoveryErr) {
            debugLog(`Auto-recovery failed: ${recoveryErr.message}`);
        }
    }
    if (!driver) {
        throw new Error('No active browser session (auto-recovery failed)');
    }
    return driver;
};
```

**Important:** `startBrowserInternal` must be defined BEFORE `getDriver` in the file for this to work.

### Step 3 — Add `await` to all 20 `getDriver()` call sites

Every `const driver = getDriver()` must become `const driver = await getDriver()`. The exact lines (in the current file) are:

| Line | Current | Change to |
|------|---------|-----------|
| 663 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 697 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 725 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 785 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 814 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 842 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 868 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 894 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 918 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 943 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1008 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1031 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1068 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1093 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1122 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1144 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1274 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1361 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1388 | `const driver = getDriver();` | `const driver = await getDriver();` |
| 1426 | `const driver = getDriver();` | `const driver = await getDriver();` |

All call sites are already inside `async` functions, so `await` is valid in every case. Use grep to verify no call sites were missed after editing: `grep -n 'getDriver()' src/lib/server.js` — every result should have `await` in front.

---

## After both fixes — rebuild and redeploy

```bash
# Rebuild the selenium-mcp image
docker build -t selenium-mcp .

# Restart the fleet (autoscaler will pick up the new image for dynamic workers;
# compose services need explicit restart to pick up the new image)
docker compose -f docker-compose.fleet.yml up -d --force-recreate selenium-1 selenium-2
```

Dynamic workers (selenium-3+) are created fresh by the autoscaler each time, so they automatically get the new image on next scale-up.

---

## Verification

1. **Fix 1:** Start a dynamic worker and run `docker inspect selenium-mcp-selenium-3-1 | grep -A5 Healthcheck` — should show `"Test": ["CMD-SHELL", "curl -sf http://localhost:3000/health || exit 1"]`.

2. **Fix 2:** With an agent running a Selenium task, manually kill its worker container: `docker kill selenium-mcp-selenium-1-1`. The agent's next tool call should auto-recover (Chrome restarts, navigation continues) rather than erroring out with "No active browser session".
