#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import pkg from 'selenium-webdriver';
const { Builder, By, Key, until, Actions } = pkg;
import { Options as ChromeOptions } from 'selenium-webdriver/chrome.js';
import { Options as FirefoxOptions } from 'selenium-webdriver/firefox.js';
import { Options as EdgeOptions } from 'selenium-webdriver/edge.js';
import fs from 'fs';
import os from 'os';
import { AsyncLocalStorage } from 'async_hooks';

// AsyncLocalStorage for threading MCP session ID to tool handlers
// In HTTP mode, each client gets its own mcp-session-id, and we use that
// to isolate browser sessions so multiple agents can run concurrently.
const mcpSessionContext = new AsyncLocalStorage();

// Build identifier — stamped at image build time via --build-arg BUILD_ID, surfaced
// in /health and get_mcp_status so a running container can be matched to its image.
const BUILD_ID = process.env.SELENIUM_MCP_BUILD_ID || 'dev';

// Cross-session diagnostic counters, exposed via /health and get_mcp_status.
const metrics = {
    transportErrors: 0,
    protocolErrors: 0,
    misrouteGuardTrips: 0
};

// Debug logging to file (console.error doesn't appear in docker logs for some reason)
const DEBUG_LOG = '/tmp/selenium-debug.log';
function debugLog(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(DEBUG_LOG, line);
    } catch (e) { /* ignore */ }
    console.error(msg);
}


// Startup log to confirm module loads
fs.writeFileSync('/tmp/server-startup.txt', `Server module loaded at ${new Date().toISOString()}\n`);
debugLog('Server module loaded');

// Server state
const state = {
    drivers: new Map(),
    currentSession: null,
    // Dynamic state (populated at runtime)
    browserHealth: {},
    recentErrors: [],
    // Per-driver health tracking: driverKey → { healthy, failCount, checkedAt, error }
    driverHealth: new Map()
};

// External state file path (mounted volume at /data)
const EXTERNAL_STATE_FILE = '/data/mcp-state.json';
const FEEDBACK_LOG_FILE = '/data/agent-feedback.jsonl';

// Default state (fallback if no external file)
const DEFAULT_MCP_STATE = {
    knownIssues: [
        {
            id: 'firefox-zombie',
            browser: 'firefox',
            severity: 'high',
            description: 'Firefox becomes zombie process after navigation in container environments',
            workaround: 'Use host.docker.internal instead of localhost/127.0.0.1',
            active: true
        },
        {
            id: 'chrome-localhost-bypass',
            browser: 'chrome',
            severity: 'blocker',
            description: 'Chrome hardcodes localhost/127.0.0.1 proxy bypass - cannot be overridden',
            workaround: 'Use host.docker.internal:PORT instead of localhost:PORT',
            active: true
        }
    ],
    workingPatterns: [
        {
            pattern: 'host-access',
            description: 'Access host machine services from container',
            recommended: 'http://host.docker.internal:PORT',
            avoid: ['http://localhost:PORT', 'http://127.0.0.1:PORT'],
            reason: 'Browsers bypass proxy for loopback addresses'
        }
    ],
    notes: []
};

// Read external state file (or return defaults)
function readExternalState() {
    try {
        if (fs.existsSync(EXTERNAL_STATE_FILE)) {
            const content = fs.readFileSync(EXTERNAL_STATE_FILE, 'utf8');
            const parsed = JSON.parse(content);
            debugLog(`Loaded external state from ${EXTERNAL_STATE_FILE}`);
            return { ...DEFAULT_MCP_STATE, ...parsed };
        }
    } catch (e) {
        debugLog(`Error reading external state: ${e.message}`);
    }
    return DEFAULT_MCP_STATE;
}

// Write to external state file (for error recording)
function writeExternalState(newState) {
    try {
        fs.writeFileSync(EXTERNAL_STATE_FILE, JSON.stringify(newState, null, 2));
        debugLog(`Wrote external state to ${EXTERNAL_STATE_FILE}`);
    } catch (e) {
        debugLog(`Error writing external state: ${e.message}`);
    }
}

// Chrome crash error signatures — these mean the browser process/tab is dead,
// not just a transient network or selector error.
const CHROME_CRASH_PATTERNS = /tab crashed|no such session|session deleted|chrome not reachable|no such window|target window already closed|session not created|cannot determine loading status/i;

// Tracks when each driver last ran a successful tool call (used by idle health check)
const lastToolSuccessAt = new Map();

// Mark a driver session as healthy after a successful tool call
function recordSuccess(key) {
    if (!key) return;
    lastToolSuccessAt.set(key, Date.now());
    const h = state.driverHealth.get(key);
    if (h && !h.healthy) {
        state.driverHealth.set(key, { healthy: true, failCount: 0, checkedAt: Date.now() });
    }
}

// Helper to record errors for cross-session visibility
function recordError(context, error) {
    const errorEntry = {
        timestamp: new Date().toISOString(),
        context,
        message: error.message || String(error)
    };

    // Update in-memory state
    state.recentErrors.unshift(errorEntry);
    if (state.recentErrors.length > 10) {
        state.recentErrors.pop();
    }

    // Also persist to external file
    try {
        const externalState = readExternalState();
        externalState.recentErrors = externalState.recentErrors || [];
        externalState.recentErrors.unshift(errorEntry);
        if (externalState.recentErrors.length > 10) {
            externalState.recentErrors.pop();
        }
        externalState.lastErrorUpdate = new Date().toISOString();
        writeExternalState(externalState);
    } catch (e) {
        debugLog(`Failed to persist error to external state: ${e.message}`);
    }

    // Reactive Chrome crash detection — update driverHealth immediately when a
    // tool call returns a crash-signature error. No polling needed; no false positives.
    if (CHROME_CRASH_PATTERNS.test(errorEntry.message)) {
        const key = getMcpSessionId() || state.currentSession;
        if (key && state.drivers.has(key)) {
            const prev = state.driverHealth.get(key) || { failCount: 0 };
            const failCount = prev.failCount + 1;
            state.driverHealth.set(key, { healthy: false, failCount, checkedAt: Date.now(), error: errorEntry.message });
            console.error(`Chrome crash detected for session ${key} (fail #${failCount}): ${errorEntry.message}`);
        }
    }
}

// Helper: get the MCP session ID from AsyncLocalStorage (HTTP mode) or fall back to global (STDIO)
const getMcpSessionId = () => {
    const store = mcpSessionContext.getStore();
    return store?.mcpSessionId || null;
};

// Helper: get the driver key for the current caller
const getDriverKey = () => {
    return getMcpSessionId() || state.currentSession;
};

// Helper functions
const getDriver = () => {
    const key = getDriverKey();
    const driver = key ? state.drivers.get(key) : null;
    if (!driver) {
        throw new Error('No active browser session');
    }
    return driver;
};

const getLocator = (by, value) => {
    switch (by.toLowerCase()) {
        case 'id': return By.id(value);
        case 'css': return By.css(value);
        case 'xpath': return By.xpath(value);
        case 'name': return By.name(value);
        case 'tag': return By.css(value);
        case 'class': return By.className(value);
        default: throw new Error(`Unsupported locator strategy: ${by}`);
    }
};

// Shadow DOM piercing helper - finds element by recursively searching through shadow roots
const findElementPiercingShadow = async (driver, selector, timeout = 10000) => {
    const script = `
        function querySelectorDeep(selector, root = document) {
            // Try to find in current context first
            let element = root.querySelector(selector);
            if (element) return element;

            // Search through all shadow roots
            const allElements = root.querySelectorAll('*');
            for (const el of allElements) {
                if (el.shadowRoot) {
                    element = querySelectorDeep(selector, el.shadowRoot);
                    if (element) return element;
                }
            }
            return null;
        }
        return querySelectorDeep(arguments[0]);
    `;

    const endTime = Date.now() + timeout;
    while (Date.now() < endTime) {
        const element = await driver.executeScript(script, selector);
        if (element) return element;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Element not found with shadow piercing: ${selector}`);
};

// Common schemas
const browserOptionsSchema = z.object({
    headless: z.boolean().optional().describe("Run browser in headless mode"),
    arguments: z.array(z.string()).optional().describe("Additional browser arguments")
}).optional();

const locatorSchema = {
    by: z.enum(["id", "css", "xpath", "name", "tag", "class"]).describe("Locator strategy to find element"),
    value: z.string().describe("Value for the locator strategy"),
    timeout: z.number().optional().describe("Maximum time to wait for element in milliseconds"),
    pierce_shadow: z.boolean().optional().describe("If true, searches through Shadow DOM boundaries. Only works with CSS selectors.")
};

// Creates a brand-new McpServer with every tool registered on it. Called once per
// HTTP session (see the /mcp route) and once for the single STDIO session, so that
// no two sessions ever share a server whose Protocol.connect() would silently
// overwrite the other's transport (see node_modules/@modelcontextprotocol/sdk
// dist/esm/shared/protocol.js — connect() replaces this._transport wholesale).
function createMcpServer() {
    const server = new McpServer({
        name: "MCP Selenium",
        version: "1.0.0"
    });

// Browser Management Tools
server.tool(
    "start_browser",
    "launches browser",
    {
        browser: z.enum(["chrome", "firefox", "edge"]).describe("Browser to launch (chrome or firefox or microsoft edge)"),
        options: browserOptionsSchema
    },
    async ({ browser, options = {} }) => {
        // Direct file write test (bypassing debugLog)
        try {
            fs.appendFileSync('/tmp/start_browser_called.txt', `Called at ${new Date().toISOString()} with browser=${browser}\n`);
        } catch (writeErr) {
            fs.appendFileSync('/tmp/write_error.txt', `Write error: ${writeErr.message}\n`);
        }
        debugLog(`=== start_browser called: browser=${browser}, options=${JSON.stringify(options)} ===`);
        try {
            const mcpSession = getMcpSessionId();

            if (mcpSession) {
                // HTTP mode: only clean up THIS session's browser
                const existingDriver = state.drivers.get(mcpSession);
                if (existingDriver) {
                    debugLog(`Cleaning up existing browser for MCP session ${mcpSession}`);
                    try { await existingDriver.quit(); } catch (e) { /* ignore */ }
                    state.drivers.delete(mcpSession);
                }
            } else {
                // STDIO mode: clean up all sessions (only one expected)
                for (const [sessionId, existingDriver] of state.drivers) {
                    try {
                        await existingDriver.quit();
                    } catch (e) { /* ignore */ }
                }
                state.drivers.clear();
                state.currentSession = null;

                // Kill any orphaned browser processes (only safe in single-session mode)
                try {
                    const { execSync } = await import('child_process');
                    execSync('pkill -9 chromium || true', { stdio: 'ignore' });
                    execSync('pkill -9 chrome || true', { stdio: 'ignore' });
                    execSync('rm -rf /tmp/chrome-* /tmp/.org.chromium.* || true', { stdio: 'ignore' });
                } catch (e) { /* ignore cleanup errors */ }
            }

            const remoteUrl = process.env.SELENIUM_REMOTE_URL || null;
            let builder = new Builder();
            if (remoteUrl) {
                builder = builder.usingServer(remoteUrl);
                debugLog(`Using remote Selenium Grid: ${remoteUrl}`);
            }
            let driver;

            // Generate unique temp dir for this session
            const sessionTempDir = `/tmp/chrome-${Date.now()}-${Math.random().toString(36).slice(2)}`;

            // Auto-detect if we need headless mode (no DISPLAY = container/headless environment)
            const hasDisplay = !!process.env.DISPLAY || !!remoteUrl;
            const forceHeadless = !hasDisplay && options.headless === false;
            const useHeadless = options.headless === true || !hasDisplay;

            if (forceHeadless) {
                console.error('Warning: headless=false requested but no DISPLAY available. Forcing headless mode.');
            }

            switch (browser) {
                case 'chrome': {
                    const chromeOptions = new ChromeOptions();
                    // Support base image (Chromium) and VNC image (Google Chrome)
                    if (process.env.CHROME_BIN) {
                        chromeOptions.setChromeBinaryPath(process.env.CHROME_BIN);
                    }
                    if (useHeadless) {
                        chromeOptions.addArguments('--headless=new');
                    }
                    // Use unique user-data-dir for this session
                    chromeOptions.addArguments(`--user-data-dir=${sessionTempDir}`);
                    // Container-friendly Chrome arguments
                    chromeOptions.addArguments('--disable-dev-shm-usage');
                    chromeOptions.addArguments('--no-sandbox');
                    chromeOptions.addArguments('--disable-gpu');
                    // Memory containment — prevents OOM in long-running container sessions
                    chromeOptions.addArguments('--renderer-process-limit=2');
                    chromeOptions.addArguments('--disable-extensions');
                    chromeOptions.addArguments('--disable-default-apps');
                    chromeOptions.addArguments('--disk-cache-size=67108864');   // 64MB
                    chromeOptions.addArguments('--media-cache-size=8388608');   // 8MB
                    chromeOptions.addArguments('--js-flags=--max-old-space-size=1024');

                    // Stealth/Anti-detection arguments
                    chromeOptions.addArguments('--disable-blink-features=AutomationControlled');
                    chromeOptions.addArguments('--disable-infobars');
                    chromeOptions.addArguments('--window-size=1920,1080');
                    chromeOptions.addArguments('--start-maximized');
                    chromeOptions.addArguments('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
                    // Exclude automation switches
                    chromeOptions.excludeSwitches('enable-automation');
                    chromeOptions.setUserPreferences({
                        'credentials_enable_service': false,
                        'profile.password_manager_enabled': false
                    });

                    if (options.arguments) {
                        // Filter out user-data-dir to avoid conflicts
                        options.arguments
                            .filter(arg => !arg.includes('user-data-dir'))
                            .forEach(arg => chromeOptions.addArguments(arg));
                    }

                    // Configure proxy if HTTP_PROXY is set
                    const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
                    if (proxyUrl) {
                        const proxyMatch = proxyUrl.match(/https?:\/\/([^:\/]+):?(\d+)?/);
                        if (proxyMatch) {
                            const proxyHost = proxyMatch[1];
                            const proxyPort = proxyMatch[2] || '3128';

                            // Resolve hostname to IP since Chrome bypasses container DNS
                            let proxyIp = proxyHost;
                            try {
                                const { lookup } = await import('dns/promises');
                                const result = await lookup(proxyHost);
                                proxyIp = result.address;
                                console.error(`✓ Resolved proxy ${proxyHost} to ${proxyIp}`);
                            } catch (e) {
                                console.error(`DNS lookup failed for ${proxyHost}, using as-is`);
                            }

                            chromeOptions.addArguments(`--proxy-server=${proxyIp}:${proxyPort}`);
                            // Block Google service requests to prevent hangs when behind proxy
                            chromeOptions.addArguments('--host-resolver-rules=MAP *.googleapis.com 127.0.0.1, MAP *.google.com 127.0.0.1, MAP *.gstatic.com 127.0.0.1');
                            chromeOptions.addArguments('--disable-background-networking');
                            chromeOptions.addArguments('--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction');
                            console.error(`✓ Configured Chrome to use proxy: ${proxyIp}:${proxyPort}`);
                        }
                    }

                    const buildTimeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Chrome browser start timed out after 30s — Selenium Grid may not be ready')), 30000)
                    );
                    driver = await Promise.race([
                        builder.forBrowser('chrome').setChromeOptions(chromeOptions).build(),
                        buildTimeout
                    ]);

                    // Comprehensive stealth JavaScript (mimics puppeteer-extra-plugin-stealth)
                    // Use CDP to inject BEFORE page scripts execute
                    const stealthScript = `
                        // 1. Remove navigator.webdriver
                        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                        delete Object.getPrototypeOf(navigator).webdriver;

                        // 2. Mock chrome object
                        if (!window.chrome) {
                            Object.defineProperty(window, 'chrome', {
                                writable: true,
                                enumerable: true,
                                configurable: false,
                                value: {}
                            });
                        }

                        // 3. chrome.app mock
                        window.chrome.app = {
                            isInstalled: false,
                            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
                            getDetails: function() { return null; },
                            getIsInstalled: function() { return false; },
                            runningState: function() { return 'cannot_run'; }
                        };

                        // 4. chrome.csi mock
                        window.chrome.csi = function() {
                            return {
                                onloadT: Date.now(),
                                startE: Date.now() - Math.floor(Math.random() * 1000),
                                pageT: Math.floor(Math.random() * 1000),
                                tran: 15
                            };
                        };

                        // 5. chrome.loadTimes mock
                        window.chrome.loadTimes = function() {
                            return {
                                commitLoadTime: Date.now() / 1000,
                                connectionInfo: 'h2',
                                finishDocumentLoadTime: Date.now() / 1000,
                                finishLoadTime: Date.now() / 1000,
                                firstPaintAfterLoadTime: 0,
                                firstPaintTime: Date.now() / 1000,
                                navigationType: 'Other',
                                npnNegotiatedProtocol: 'h2',
                                requestTime: Date.now() / 1000 - 0.1,
                                startLoadTime: Date.now() / 1000 - 0.1,
                                wasAlternateProtocolAvailable: false,
                                wasFetchedViaSpdy: true,
                                wasNpnNegotiated: true
                            };
                        };

                        // 6. chrome.runtime mock
                        window.chrome.runtime = {
                            OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
                            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
                            PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                            PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
                            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
                            connect: function() { return { onDisconnect: { addListener: function() {} }, onMessage: { addListener: function() {} }, postMessage: function() {} }; },
                            sendMessage: function() {}
                        };

                        // 7. Mock navigator.plugins and mimeTypes
                        const pluginData = [
                            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                        ];
                        const pluginArray = pluginData.map(p => {
                            const plugin = Object.create(Plugin.prototype);
                            Object.defineProperties(plugin, {
                                name: { value: p.name, enumerable: true },
                                filename: { value: p.filename, enumerable: true },
                                description: { value: p.description, enumerable: true },
                                length: { value: 0, enumerable: true }
                            });
                            return plugin;
                        });
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => {
                                const arr = [...pluginArray];
                                arr.item = i => arr[i] || null;
                                arr.namedItem = n => arr.find(p => p.name === n) || null;
                                arr.refresh = () => {};
                                return arr;
                            }
                        });

                        // 8. Mock navigator.languages
                        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

                        // 9. WebGL vendor/renderer spoofing
                        const getParameterProxyHandler = {
                            apply: function(target, thisArg, args) {
                                const param = args[0];
                                if (param === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
                                if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
                                return Reflect.apply(target, thisArg, args);
                            }
                        };
                        try {
                            WebGLRenderingContext.prototype.getParameter = new Proxy(
                                WebGLRenderingContext.prototype.getParameter, getParameterProxyHandler
                            );
                            WebGL2RenderingContext.prototype.getParameter = new Proxy(
                                WebGL2RenderingContext.prototype.getParameter, getParameterProxyHandler
                            );
                        } catch(e) {}

                        // 10. Permissions API mock (for notifications)
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = function(parameters) {
                            if (parameters.name === 'notifications') {
                                return Promise.resolve({ state: Notification.permission });
                            }
                            return originalQuery.apply(this, arguments);
                        };

                        // 11. Mock hardware concurrency (typical desktop value)
                        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

                        // 12. Mock deviceMemory (typical desktop value)
                        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

                        // 13. Spoof screen dimensions
                        Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
                        Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
                        Object.defineProperty(screen, 'width', { get: () => 1920 });
                        Object.defineProperty(screen, 'height', { get: () => 1080 });
                        Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
                        Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });

                        // 14. Window outer dimensions
                        Object.defineProperty(window, 'outerWidth', { get: () => 1920 });
                        Object.defineProperty(window, 'outerHeight', { get: () => 1080 });
                    `;

                    // Inject via CDP for pre-page-load execution (10s timeout — non-fatal if it hangs)
                    try {
                        await Promise.race([
                            driver.sendDevToolsCommand('Page.addScriptToEvaluateOnNewDocument', { source: stealthScript }),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('CDP stealth injection timed out')), 10000))
                        ]);
                    } catch (cdpErr) {
                        console.error('CDP stealth injection failed (skipping):', cdpErr.message);
                    }
                    break;
                }
                case 'edge': {
                    const edgeOptions = new EdgeOptions();
                    if (options.headless) {
                        edgeOptions.addArguments('--headless=new');
                    }
                    if (options.arguments) {
                        options.arguments.forEach(arg => edgeOptions.addArguments(arg));
                    }
                    driver = await builder
                        .forBrowser('edge')
                        .setEdgeOptions(edgeOptions)
                        .build();
                    break;
                }
                case 'firefox': {
                    debugLog('=== Starting Firefox browser setup ===');
                    const firefoxOptions = new FirefoxOptions();
                    if (useHeadless) {
                        firefoxOptions.addArguments('-headless');
                        debugLog('Headless mode enabled');
                    }

                    // Disable sandbox for container environments
                    firefoxOptions.setPreference('security.sandbox.content.level', 0);
                    firefoxOptions.setPreference('security.sandbox.gpu.level', 0);
                    // Disable various Firefox features that cause issues in containers
                    firefoxOptions.setPreference('browser.tabs.remote.autostart', false);
                    firefoxOptions.setPreference('browser.tabs.remote.autostart.2', false);
                    firefoxOptions.setPreference('dom.ipc.processCount', 1);
                    firefoxOptions.setPreference('toolkit.cosmeticAnimations.enabled', false);
                    firefoxOptions.setPreference('media.hardware-video-decoding.enabled', false);
                    // Disable crash reporter and telemetry
                    firefoxOptions.setPreference('toolkit.telemetry.reportingpolicy.firstRun', false);
                    firefoxOptions.setPreference('datareporting.policy.dataSubmissionEnabled', false);
                    firefoxOptions.setPreference('browser.crashReports.unsubmittedCheck.enabled', false);
                    debugLog('Sandbox and container-incompatible features disabled');

                    // Allow Firefox to bypass proxy for localhost (socat will handle forwarding)
                    // This lets Firefox connect directly to localhost:8000 where socat forwards to host
                    firefoxOptions.setPreference('network.proxy.no_proxies_on', 'localhost, 127.0.0.1');
                    debugLog('Localhost proxy bypass enabled (socat handles forwarding)');

                    if (options.arguments) {
                        options.arguments.forEach(arg => firefoxOptions.addArguments(arg));
                    }

                    // Configure proxy if HTTP_PROXY is set
                    const firefoxProxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
                    debugLog(`HTTP_PROXY env: ${firefoxProxyUrl}`);
                    if (firefoxProxyUrl) {
                        const firefoxProxyMatch = firefoxProxyUrl.match(/https?:\/\/([^:\/]+):?(\d+)?/);
                        debugLog(`Proxy regex match: ${JSON.stringify(firefoxProxyMatch)}`);
                        if (firefoxProxyMatch) {
                            const proxyHost = firefoxProxyMatch[1];
                            const proxyPort = firefoxProxyMatch[2] || '3128';

                            // Resolve hostname to IP
                            let proxyIp = proxyHost;
                            try {
                                const { lookup } = await import('dns/promises');
                                const result = await lookup(proxyHost);
                                proxyIp = result.address;
                                debugLog(`Resolved proxy ${proxyHost} to ${proxyIp}`);
                            } catch (e) {
                                debugLog(`DNS lookup failed for ${proxyHost}: ${e.message}, using hostname`);
                            }

                            // Set manual proxy configuration (type 1)
                            firefoxOptions.setPreference('network.proxy.type', 1);
                            firefoxOptions.setPreference('network.proxy.http', proxyIp);
                            firefoxOptions.setPreference('network.proxy.http_port', parseInt(proxyPort));
                            firefoxOptions.setPreference('network.proxy.ssl', proxyIp);
                            firefoxOptions.setPreference('network.proxy.ssl_port', parseInt(proxyPort));
                            // IMPORTANT: Preserve localhost bypass for socat forwarding (OAuth callbacks)
                            // Do NOT set to '' - that breaks localhost:8000 access
                            firefoxOptions.setPreference('network.proxy.no_proxies_on', 'localhost, 127.0.0.1');

                            debugLog(`Configured Firefox manual proxy: ${proxyIp}:${proxyPort}`);
                        }
                    } else {
                        debugLog('No HTTP_PROXY env var found');
                    }

                    // Set Firefox binary path explicitly to avoid selenium-manager network calls
                    const firefoxBin = process.env.FIREFOX_BIN || '/root/.cache/selenium/firefox/linux64/147.0.2/firefox';
                    firefoxOptions.setBinary(firefoxBin);
                    debugLog(`Firefox binary: ${firefoxBin}`);

                    // Set geckodriver path
                    const geckodriverPath = process.env.GECKODRIVER_PATH || '/root/.cache/selenium/geckodriver/linux64/0.36.0/geckodriver';
                    debugLog(`Geckodriver: ${geckodriverPath}`);

                    const { ServiceBuilder } = await import('selenium-webdriver/firefox.js');
                    const firefoxService = new ServiceBuilder(geckodriverPath);

                    driver = await builder
                        .forBrowser('firefox')
                        .setFirefoxOptions(firefoxOptions)
                        .setFirefoxService(firefoxService)
                        .build();
                    debugLog('Firefox driver built successfully');
                    break;
                }
                default: {
                    throw new Error(`Unsupported browser: ${browser}`);
                }
            }
            // Set page load timeout so navigate fails fast instead of hanging (default is 300s)
            await driver.manage().setTimeouts({ pageLoad: 30000 });

            // Use MCP session ID as driver key (HTTP mode) or generate one (STDIO mode)
            const driverKey = mcpSession || `${browser}_${Date.now()}`;
            state.drivers.set(driverKey, driver);
            if (!mcpSession) {
                state.currentSession = driverKey;
            }

            const containerId = os.hostname();
            const activeBrowsers = state.drivers.size;
            debugLog(`Browser started: key=${driverKey}, active_browsers=${activeBrowsers}`);
            return {
                content: [{ type: 'text', text: `Browser started with session_id: ${driverKey}\nContainer: ${containerId}\nActive browsers: ${activeBrowsers}` }]
            };
        } catch (e) {
            recordError('start_browser', e);
            return {
                content: [{ type: 'text', text: `Error starting browser: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "navigate",
    "navigates to a URL",
    {
        url: z.string().describe("URL to navigate to")
    },
    async ({ url }) => {
        try {
            const driver = getDriver();

            // Check for localhost URLs and warn about known issues
            if (url.includes('localhost') || url.includes('127.0.0.1')) {
                const warning = `WARNING: Navigating to ${url} - browsers may bypass proxy for localhost. Consider using host.docker.internal instead.`;
                debugLog(warning);
                recordError('navigate-localhost-warning', { message: warning });
            }

            await Promise.race([
                driver.get(url),
                new Promise((_, reject) => setTimeout(() => reject(new Error('navigate timed out after 35s')), 35000))
            ]);
            recordSuccess(getDriverKey());
            return {
                content: [{ type: 'text', text: `Navigated to ${url}` }]
            };
        } catch (e) {
            recordError(`navigate:${url}`, e);
            return {
                content: [{ type: 'text', text: `Error navigating: ${e.message}` }]
            };
        }
    }
);

// Element Interaction Tools
server.tool(
    "find_element",
    "finds an element",
    {
        ...locatorSchema
    },
    async ({ by, value, timeout = 10000, pierce_shadow = false }) => {
        try {
            const driver = getDriver();
            if (pierce_shadow && by === 'css') {
                await findElementPiercingShadow(driver, value, timeout);
            } else {
                const locator = getLocator(by, value);
                await driver.wait(until.elementLocated(locator), timeout);
            }
            return {
                content: [{ type: 'text', text: 'Element found' }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error finding element: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "click_element",
    "clicks an element. Use force=true to bypass 'element not interactable' errors by using Actions API or JavaScript fallback.",
    {
        ...locatorSchema,
        force: z.boolean().optional().describe("If true, uses Actions API move+click or JS click as fallback when element is not interactable"),
        scroll_into_view: z.boolean().optional().describe("If true, scrolls element into view before clicking")
    },
    async ({ by, value, timeout = 10000, pierce_shadow = false, force = false, scroll_into_view = false }) => {
        try {
            const driver = getDriver();
            let element;
            if (pierce_shadow && by === 'css') {
                element = await findElementPiercingShadow(driver, value, timeout);
            } else {
                const locator = getLocator(by, value);
                element = await driver.wait(until.elementLocated(locator), timeout);
            }

            // Optionally scroll into view first
            if (scroll_into_view) {
                await driver.executeScript("arguments[0].scrollIntoView({block: 'center', behavior: 'instant'});", element);
                await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause for scroll
            }

            // Try normal click first
            try {
                await element.click();
                return {
                    content: [{ type: 'text', text: 'Element clicked' }]
                };
            } catch (clickErr) {
                if (!force) {
                    throw clickErr;
                }

                // Force mode: try Actions API
                debugLog(`Normal click failed (${clickErr.message}), trying Actions API...`);
                try {
                    const actions = driver.actions({ bridge: true });
                    await actions.move({ origin: element }).click().perform();
                    return {
                        content: [{ type: 'text', text: 'Element clicked (via Actions API)' }]
                    };
                } catch (actionsErr) {
                    // Last resort: JavaScript click
                    debugLog(`Actions API click failed (${actionsErr.message}), trying JS click...`);
                    await driver.executeScript("arguments[0].click();", element);
                    return {
                        content: [{ type: 'text', text: 'Element clicked (via JavaScript)' }]
                    };
                }
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error clicking element: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "send_keys",
    "sends keys to an element, aka typing",
    {
        ...locatorSchema,
        text: z.string().describe("Text to enter into the element")
    },
    async ({ by, value, text, timeout = 10000, pierce_shadow = false }) => {
        try {
            const driver = getDriver();
            let element;
            if (pierce_shadow && by === 'css') {
                element = await findElementPiercingShadow(driver, value, timeout);
            } else {
                const locator = getLocator(by, value);
                element = await driver.wait(until.elementLocated(locator), timeout);
            }
            await element.clear();
            await element.sendKeys(text);
            return {
                content: [{ type: 'text', text: `Text "${text}" entered into element` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error entering text: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "get_element_text",
    "gets the text() of an element",
    {
        ...locatorSchema
    },
    async ({ by, value, timeout = 10000, pierce_shadow = false }) => {
        try {
            const driver = getDriver();
            let element;
            if (pierce_shadow && by === 'css') {
                element = await findElementPiercingShadow(driver, value, timeout);
            } else {
                const locator = getLocator(by, value);
                element = await driver.wait(until.elementLocated(locator), timeout);
            }
            const text = await element.getText();
            return {
                content: [{ type: 'text', text }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting element text: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "hover",
    "moves the mouse to hover over an element",
    {
        ...locatorSchema
    },
    async ({ by, value, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const actions = driver.actions({ bridge: true });
            await actions.move({ origin: element }).perform();
            return {
                content: [{ type: 'text', text: 'Hovered over element' }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error hovering over element: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "drag_and_drop",
    "drags an element and drops it onto another element",
    {
        ...locatorSchema,
        targetBy: z.enum(["id", "css", "xpath", "name", "tag", "class"]).describe("Locator strategy to find target element"),
        targetValue: z.string().describe("Value for the target locator strategy")
    },
    async ({ by, value, targetBy, targetValue, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const sourceLocator = getLocator(by, value);
            const targetLocator = getLocator(targetBy, targetValue);
            const sourceElement = await driver.wait(until.elementLocated(sourceLocator), timeout);
            const targetElement = await driver.wait(until.elementLocated(targetLocator), timeout);
            const actions = driver.actions({ bridge: true });
            await actions.dragAndDrop(sourceElement, targetElement).perform();
            return {
                content: [{ type: 'text', text: 'Drag and drop completed' }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error performing drag and drop: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "double_click",
    "performs a double click on an element",
    {
        ...locatorSchema
    },
    async ({ by, value, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const actions = driver.actions({ bridge: true });
            await actions.doubleClick(element).perform();
            return {
                content: [{ type: 'text', text: 'Double click performed' }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error performing double click: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "right_click",
    "performs a right click (context click) on an element",
    {
        ...locatorSchema
    },
    async ({ by, value, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const actions = driver.actions({ bridge: true });
            await actions.contextClick(element).perform();
            return {
                content: [{ type: 'text', text: 'Right click performed' }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error performing right click: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "click_at_coordinates",
    "clicks at specific x,y coordinates on the page using Actions API. Useful when element selectors fail.",
    {
        x: z.coerce.number().describe("X coordinate (pixels from left edge of viewport)"),
        y: z.coerce.number().describe("Y coordinate (pixels from top edge of viewport)")
    },
    async ({ x, y }) => {
        try {
            const driver = getDriver();
            const actions = driver.actions({ bridge: true });
            // Move to coordinates relative to viewport and click
            await actions.move({ x: Math.round(x), y: Math.round(y), origin: 'viewport' }).click().perform();
            return {
                content: [{ type: 'text', text: `Clicked at coordinates (${x}, ${y})` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error clicking at coordinates: ${e.message}` }]
            };
        }
    }
);

// Map common key names to Selenium Key constants
const getKeyConstant = (keyName) => {
    const keyMap = {
        'enter': Key.ENTER,
        'return': Key.RETURN,
        'tab': Key.TAB,
        'escape': Key.ESCAPE,
        'esc': Key.ESCAPE,
        'backspace': Key.BACK_SPACE,
        'delete': Key.DELETE,
        'space': Key.SPACE,
        'up': Key.UP,
        'down': Key.DOWN,
        'left': Key.LEFT,
        'right': Key.RIGHT,
        'home': Key.HOME,
        'end': Key.END,
        'pageup': Key.PAGE_UP,
        'pagedown': Key.PAGE_DOWN,
        'shift': Key.SHIFT,
        'control': Key.CONTROL,
        'ctrl': Key.CONTROL,
        'alt': Key.ALT,
        'meta': Key.META,
        'command': Key.COMMAND,
        'f1': Key.F1,
        'f2': Key.F2,
        'f3': Key.F3,
        'f4': Key.F4,
        'f5': Key.F5,
        'f6': Key.F6,
        'f7': Key.F7,
        'f8': Key.F8,
        'f9': Key.F9,
        'f10': Key.F10,
        'f11': Key.F11,
        'f12': Key.F12,
    };
    const normalizedKey = keyName.toLowerCase().trim();
    return keyMap[normalizedKey] || keyName;
};

server.tool(
    "press_key",
    "simulates pressing a keyboard key. Supports special keys: Enter, Tab, Escape, Backspace, Delete, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, Shift, Control/Ctrl, Alt, Meta/Command, F1-F12",
    {
        key: z.string().describe("Key to press (e.g., 'Enter', 'Tab', 'Escape', 'a', 'Ctrl', etc.)")
    },
    async ({ key }) => {
        try {
            const driver = getDriver();
            const actions = driver.actions({ bridge: true });
            const resolvedKey = getKeyConstant(key);
            await actions.keyDown(resolvedKey).keyUp(resolvedKey).perform();
            return {
                content: [{ type: 'text', text: `Key '${key}' pressed` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error pressing key: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "type_keys",
    "Types text and/or special keys to the currently focused element using Actions API. Use {Enter}, {Tab}, etc. for special keys within the text. More reliable than send_keys for complex inputs.",
    {
        text: z.string().describe("Text to type. Embed special keys using {KeyName} syntax, e.g., 'Hello{Enter}' or 'user{Tab}password{Enter}'")
    },
    async ({ text }) => {
        try {
            const driver = getDriver();
            const actions = driver.actions({ bridge: true });

            // Parse text for {SpecialKey} patterns and build action sequence
            const parts = text.split(/(\{[^}]+\})/);
            for (const part of parts) {
                if (part.startsWith('{') && part.endsWith('}')) {
                    // Special key
                    const keyName = part.slice(1, -1);
                    const resolvedKey = getKeyConstant(keyName);
                    actions.keyDown(resolvedKey).keyUp(resolvedKey);
                } else if (part.length > 0) {
                    // Regular text
                    actions.sendKeys(part);
                }
            }
            await actions.perform();
            return {
                content: [{ type: 'text', text: `Typed: ${text}` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error typing keys: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "upload_file",
    "uploads a file using a file input element",
    {
        ...locatorSchema,
        filePath: z.string().describe("Absolute path to the file to upload")
    },
    async ({ by, value, filePath, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await element.sendKeys(filePath);
            return {
                content: [{ type: 'text', text: 'File upload initiated' }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error uploading file: ${e.message}` }]
            };
        }
    }
);

// Frame handling tools
server.tool(
    "switch_to_frame",
    "switches context to an iframe. Use index (0-based) or locator (css/xpath) to identify the frame",
    {
        by: z.enum(["index", "css", "xpath"]).describe("How to locate the frame: 'index' for frame number, or 'css'/'xpath' for selector"),
        value: z.string().describe("Frame index (e.g. '0') or CSS/XPath selector (e.g. 'iframe#chat-widget')")
    },
    async ({ by, value }) => {
        try {
            const driver = getDriver();
            if (by === "index") {
                const index = parseInt(value, 10);
                await driver.switchTo().frame(index);
                return {
                    content: [{ type: 'text', text: `Switched to frame at index ${index}` }]
                };
            } else {
                const locator = getLocator(by, value);
                const frameElement = await driver.findElement(locator);
                await driver.switchTo().frame(frameElement);
                return {
                    content: [{ type: 'text', text: `Switched to frame: ${value}` }]
                };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error switching to frame: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "switch_to_default_content",
    "switches back to the main page context from an iframe",
    {},
    async () => {
        try {
            const driver = getDriver();
            await driver.switchTo().defaultContent();
            return {
                content: [{ type: 'text', text: 'Switched back to main page context' }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error switching to default content: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "execute_script",
    "SECURITY WARNING: Executes arbitrary JavaScript in the browser context. This is a powerful tool that can access cookies, session data, and perform any action the page can. Use pierce_shadow option on other tools instead when possible. Only use this for advanced cases like custom scrolling or accessing data not available through other tools.",
    {
        script: z.string().describe("JavaScript code to execute. Use 'return' to get a value back. Use 'arguments[0]', 'arguments[1]', etc. to access args."),
        args: z.array(z.any()).optional().describe("Optional array of arguments to pass to the script")
    },
    async ({ script, args = [] }) => {
        try {
            const driver = getDriver();
            const result = await driver.executeScript(script, ...args);
            return {
                content: [{ type: 'text', text: `Script executed. Result: ${JSON.stringify(result)}` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error executing script: ${e.message}` }]
            };
        }
    }
);

// --- execute_docker_script: hardened script execution restricted to Docker host endpoints ---

const DOCKER_HOST_ALLOWLIST = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'];

function isDockerHostUrl(urlString) {
    try {
        const url = new URL(urlString);
        return DOCKER_HOST_ALLOWLIST.includes(url.hostname);
    } catch {
        return false;
    }
}

// Layer 2: Static analysis — block patterns that could bypass the runtime sandbox
const BLOCKED_SCRIPT_PATTERNS = [
    { pattern: /\beval\s*\(/,               reason: 'eval() is blocked' },
    { pattern: /\bFunction\s*\(/,            reason: 'Function constructor is blocked' },
    { pattern: /\bnew\s+Function\b/,         reason: 'Function constructor is blocked' },
    { pattern: /\.contentWindow\b/,          reason: 'contentWindow access is blocked (sandbox escape)' },
    { pattern: /\.contentDocument\b/,        reason: 'contentDocument access is blocked (sandbox escape)' },
    { pattern: /\bimport\s*\(/,              reason: 'dynamic import() is blocked' },
    { pattern: /\bimportScripts\s*\(/,       reason: 'importScripts is blocked' },
    { pattern: /\bdocument\.write\s*\(/,     reason: 'document.write is blocked' },
    { pattern: /\bdocument\.writeln\s*\(/,   reason: 'document.writeln is blocked' },
    { pattern: /\b__proto__\b/,              reason: '__proto__ access is blocked' },
    { pattern: /\bProxy\s*\(/,              reason: 'Proxy constructor is blocked' },
    { pattern: /\bReflect\s*\./,             reason: 'Reflect API is blocked' },
    { pattern: /\bObject\.definePropert/,    reason: 'Object.defineProperty is blocked (anti-tamper)' },
    { pattern: /\bObject\.getOwnPropertyDescriptor/,  reason: 'Object.getOwnPropertyDescriptor is blocked (anti-tamper)' },
    { pattern: /\bObject\.getPrototypeOf/,   reason: 'Object.getPrototypeOf is blocked (anti-tamper)' },
    { pattern: /\bsetTimeout\s*\(\s*['"`]/,  reason: 'setTimeout with string argument is blocked' },
    { pattern: /\bsetInterval\s*\(\s*['"`]/, reason: 'setInterval with string argument is blocked' },
];

// Layer 3: Runtime network sandbox — injected into the page before the user script runs.
// Uses Object.defineProperty with configurable:false to prevent overrides from being undone.
const DOCKER_SCRIPT_SANDBOX = `(function() {
  if (window.__docker_script_sandbox_applied) return;
  var A = ${JSON.stringify(DOCKER_HOST_ALLOWLIST)};
  function ok(u) {
    try { return A.indexOf(new URL(u, location.origin).hostname) !== -1; }
    catch(e) { return false; }
  }
  function block(name) {
    return function() { throw new Error('Blocked: ' + name + ' is not allowed in docker_script context. This API is sealed by the security sandbox.'); };
  }
  var dp = Object.defineProperty;
  function seal(obj, prop, val) {
    try { dp(obj, prop, { value: val, writable: false, configurable: false }); }
    catch(e) { /* already sealed from a previous call — safe to skip */ }
  }

  // --- Network APIs: only allow Docker host URLs ---
  var _fetch = window.fetch;
  seal(window, 'fetch', function(input) {
    var u = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    if (!ok(u)) throw new Error('Blocked: fetch to external URL (' + u + ') not allowed. Only Docker host URLs are permitted: ' + A.join(', '));
    return _fetch.apply(this, arguments);
  });

  var _xhrOpen = XMLHttpRequest.prototype.open;
  seal(XMLHttpRequest.prototype, 'open', function(method, url) {
    if (!ok(String(url))) throw new Error('Blocked: XHR to external URL (' + url + ') not allowed. Only Docker host URLs are permitted: ' + A.join(', '));
    return _xhrOpen.apply(this, arguments);
  });

  if (window.WebSocket) {
    var _WS = window.WebSocket;
    seal(window, 'WebSocket', function(url, protocols) {
      if (!ok(String(url).replace(/^ws(s?):\\/\\//, 'http$1://'))) throw new Error('Blocked: WebSocket to external URL (' + url + ') not allowed. Only Docker host URLs are permitted: ' + A.join(', '));
      return new _WS(url, protocols);
    });
  }

  if (window.EventSource) {
    var _ES = window.EventSource;
    seal(window, 'EventSource', function(url, config) {
      if (!ok(String(url))) throw new Error('Blocked: EventSource to external URL (' + url + ') not allowed. Only Docker host URLs are permitted: ' + A.join(', '));
      return new _ES(url, config);
    });
  }

  // --- Block fire-and-forget / exfiltration APIs ---
  seal(navigator, 'sendBeacon', block('sendBeacon'));
  seal(window, 'open', block('window.open'));

  // --- Block Workers (separate execution context bypasses all sandbox overrides) ---
  seal(window, 'Worker', block('Worker'));
  seal(window, 'SharedWorker', block('SharedWorker'));

  // --- Block iframe/frame/object/embed creation (fresh API references bypass sandbox) ---
  var _createElement = document.createElement.bind(document);
  seal(document, 'createElement', function(tag) {
    var t = String(tag).toLowerCase();
    if (['iframe', 'frame', 'object', 'embed'].indexOf(t) !== -1)
      throw new Error('Blocked: creating <' + t + '> element not allowed in docker_script context. Iframe/frame/object/embed elements are blocked because they provide fresh API references that bypass the sandbox.');
    return _createElement.apply(this, arguments);
  });

  // --- Block service worker registration ---
  if (navigator.serviceWorker) {
    seal(navigator.serviceWorker, 'register', block('ServiceWorker.register'));
  }

  window.__docker_script_sandbox_applied = true;
})();
`;

server.tool(
    "execute_docker_script",
    "Executes JavaScript in the browser context, but ONLY when the browser is on a Docker host endpoint (localhost, 127.0.0.1, or host.docker.internal). Blocked on external URLs. This tool applies a network sandbox that prevents outbound requests to non-Docker-host URLs. Note: sandbox overrides persist on the page after execution.",
    {
        script: z.string().describe("JavaScript code to execute. Use 'return' to get a value back. Use 'arguments[0]', 'arguments[1]', etc. to access args. Note: eval(), Function(), Workers, iframes, and dynamic imports are blocked for security."),
        args: z.array(z.any()).optional().describe("Optional array of arguments to pass to the script")
    },
    async ({ script, args = [] }) => {
        try {
            const driver = getDriver();

            // Layer 1: Pre-execution URL check
            const currentUrl = await driver.getCurrentUrl();
            if (!isDockerHostUrl(currentUrl)) {
                return {
                    content: [{ type: 'text', text: [
                        `[SECURITY BLOCK] execute_docker_script refused: browser is on an external URL.`,
                        `  Current URL: ${currentUrl}`,
                        `  Allowed hosts: ${DOCKER_HOST_ALLOWLIST.join(', ')}`,
                        ``,
                        `To fix: use the 'navigate' tool to go to a Docker host URL first (e.g. http://localhost:8000), then retry this script.`,
                    ].join('\n') }]
                };
            }

            // Layer 2: Static analysis — reject scripts with sandbox-escape patterns
            for (const { pattern, reason } of BLOCKED_SCRIPT_PATTERNS) {
                if (pattern.test(script)) {
                    // Extract the matching snippet for agent feedback
                    const match = script.match(pattern);
                    const matchSnippet = match ? match[0] : '(unknown)';
                    return {
                        content: [{ type: 'text', text: [
                            `[SECURITY BLOCK] execute_docker_script refused: script failed static analysis.`,
                            `  Reason: ${reason}`,
                            `  Matched pattern: "${matchSnippet}"`,
                            ``,
                            `To fix: rewrite your script without using ${matchSnippet}. This API is blocked because it could be used to escape the docker_script security sandbox.`,
                            `Allowed: direct DOM access, fetch() to Docker host URLs, standard JS (no eval, no dynamic code generation, no iframes).`,
                        ].join('\n') }]
                    };
                }
            }

            // Layer 3: Inject network sandbox + execute user script
            // The sandbox IIFE runs first and seals network APIs, then the user script runs.
            // arguments[0..N] from Selenium remain accessible to the user script.
            const sandboxedScript = DOCKER_SCRIPT_SANDBOX + '\n' + script;
            const result = await driver.executeScript(sandboxedScript, ...args);

            // Layer 4: Post-execution URL check — detect navigation attempts
            const postUrl = await driver.getCurrentUrl();
            if (!isDockerHostUrl(postUrl)) {
                try { await driver.get(currentUrl); } catch (_) { /* best effort revert */ }
                return {
                    content: [{ type: 'text', text: [
                        `[SECURITY BLOCK] execute_docker_script: script navigated the browser to an external URL.`,
                        `  Navigated to: ${postUrl}`,
                        `  Reverted to: ${currentUrl}`,
                        ``,
                        `To fix: do not navigate the browser to external URLs inside docker_script. Use window.location or anchor clicks only for Docker host URLs (${DOCKER_HOST_ALLOWLIST.join(', ')}).`,
                    ].join('\n') }]
                };
            }

            return {
                content: [{ type: 'text', text: `Script executed. Result: ${JSON.stringify(result)}` }]
            };
        } catch (e) {
            // Distinguish sandbox security errors from regular JS errors
            const isSandboxBlock = e.message && e.message.includes('Blocked:');
            if (isSandboxBlock) {
                return {
                    content: [{ type: 'text', text: [
                        `[SECURITY BLOCK] execute_docker_script: runtime sandbox blocked an operation.`,
                        `  Error: ${e.message}`,
                        ``,
                        `The script attempted an operation that the network sandbox prevents. Outbound requests (fetch, XHR, WebSocket, EventSource) are only allowed to Docker host URLs: ${DOCKER_HOST_ALLOWLIST.join(', ')}.`,
                        `Fully blocked APIs: sendBeacon, window.open, Worker, SharedWorker, ServiceWorker, iframe/frame/object/embed creation.`,
                        `To fix: ensure all network requests target a Docker host URL, and avoid blocked APIs listed above.`,
                    ].join('\n') }]
                };
            }
            return {
                content: [{ type: 'text', text: `Error executing docker script: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "get_page_source",
    "gets the current page HTML source. Useful for debugging what elements are present.",
    {},
    async () => {
        try {
            const driver = getDriver();
            const source = await driver.getPageSource();
            // Truncate if too long
            const maxLength = 50000;
            const truncated = source.length > maxLength
                ? source.substring(0, maxLength) + `\n... [truncated, ${source.length - maxLength} more characters]`
                : source;
            return {
                content: [{ type: 'text', text: truncated }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting page source: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "wait_for_element",
    "waits for an element to meet a condition (visible, clickable, or present in DOM)",
    {
        ...locatorSchema,
        condition: z.enum(["visible", "clickable", "present"]).describe("Condition to wait for: 'visible' (displayed), 'clickable' (visible and enabled), 'present' (exists in DOM)")
    },
    async ({ by, value, condition, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            let element;
            switch (condition) {
                case "visible":
                    element = await driver.wait(until.elementIsVisible(driver.findElement(locator)), timeout);
                    break;
                case "clickable":
                    element = await driver.wait(until.elementLocated(locator), timeout);
                    await driver.wait(until.elementIsVisible(element), timeout);
                    await driver.wait(until.elementIsEnabled(element), timeout);
                    break;
                case "present":
                default:
                    element = await driver.wait(until.elementLocated(locator), timeout);
                    break;
            }
            return {
                content: [{ type: 'text', text: `Element is ${condition}: ${value}` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Timeout waiting for element to be ${condition}: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "take_screenshot",
    "captures a screenshot of the current page and saves to /data/screenshots directory",
    {
        outputPath: z.string().optional().describe("Filename for the screenshot (e.g. 'screenshot.png'). Use ONLY a simple filename, NOT a full path. Files are saved to /data/screenshots. If not provided, returns compressed image data directly."),
        quality: z.number().min(0.1).max(1.0).optional().describe("JPEG compression quality for inline screenshots (0.1-1.0, default 0.7). Lower = smaller file size. Ignored when saving to file."),
        maxWidth: z.number().min(100).max(3840).optional().describe("Maximum width in pixels for inline screenshots (default 1280). Image is scaled down if wider. Ignored when saving to file.")
    },
    async ({ outputPath, quality = 0.7, maxWidth = 1280 }) => {
        try {
            const driver = getDriver();
            if (outputPath) {
                const screenshot = await driver.takeScreenshot();
                const fs = await import('fs');
                const path = await import('path');
                // Extract just the filename if a full path was provided (handles Windows paths too)
                let filename = outputPath;
                // Strip Windows drive letter and path separators
                if (filename.includes(':') || filename.includes('\\') || filename.includes('/')) {
                    filename = filename.split(/[:\\/]/).pop();
                }
                // Ensure screenshots directory exists and save there
                const screenshotDir = '/data/screenshots';
                try {
                    await fs.promises.mkdir(screenshotDir, { recursive: true });
                } catch (e) { /* ignore if exists */ }
                const finalPath = `${screenshotDir}/${filename}`;
                try {
                    await fs.promises.writeFile(finalPath, screenshot, 'base64');
                    // Report host path if available
                    const hostPath = process.env.HOST_DATA_PATH
                        ? `${process.env.HOST_DATA_PATH}/screenshots/${filename}`
                        : finalPath;
                    return {
                        content: [{ type: 'text', text: `Screenshot saved to ${hostPath}` }]
                    };
                } catch (writeErr) {
                    // Fallback: return image data directly if file save fails
                    console.error(`Failed to save screenshot to ${finalPath}: ${writeErr.message}. Returning image data instead.`);
                    return {
                        content: [
                            { type: 'text', text: `Warning: Could not save to file (${writeErr.message}). Returning image directly.` },
                            { type: 'image', data: screenshot, mimeType: 'image/png' }
                        ]
                    };
                }
            } else {
                // Inline screenshot: use CDP to capture JPEG directly (avoids MCP 20MB limit).
                // CDP captures in the browser process — no large PNG transfer needed.
                let imageData;
                let mimeType;
                try {
                    const cdpTimeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('CDP screenshot timed out after 10s')), 10000)
                    );
                    const cdpResult = await Promise.race([
                        driver.sendAndGetDevToolsCommand('Page.captureScreenshot', {
                            format: 'jpeg',
                            quality: Math.round(quality * 100),
                            captureBeyondViewport: false
                        }),
                        cdpTimeout
                    ]);
                    imageData = cdpResult.data;
                    mimeType = 'image/jpeg';
                    debugLog(`CDP screenshot: JPEG quality=${Math.round(quality * 100)}, size=${imageData.length} chars`);
                } catch (cdpErr) {
                    // CDP not available (Firefox or non-Chrome) or timed out, fall back to raw PNG
                    debugLog(`CDP screenshot failed: ${cdpErr.message}, returning raw PNG`);
                    imageData = await driver.takeScreenshot();
                    mimeType = 'image/png';
                }
                recordSuccess(getDriverKey());
                return {
                    content: [
                        { type: 'image', data: imageData, mimeType }
                    ]
                };
            }
        } catch (e) {
            recordError('take_screenshot', e);
            return {
                content: [{ type: 'text', text: `Error taking screenshot: ${e.message}` }]
            };
        }
    }
);

// MCP Status Tool - allows agents to query status without using resources
server.tool(
    "get_mcp_status",
    "Get current MCP server status including known issues, working patterns, and browser health. Call this BEFORE starting browser operations to understand current limitations.",
    {},
    async () => {
        try {
            // Read external state file
            const externalState = readExternalState();

            // Update browser health dynamically
            const browserHealth = {};
            for (const [sessionId, driver] of state.drivers) {
                try {
                    await driver.getTitle();
                    browserHealth[sessionId] = { status: 'healthy', lastCheck: new Date().toISOString() };
                } catch (e) {
                    browserHealth[sessionId] = { status: 'unhealthy', error: e.message, lastCheck: new Date().toISOString() };
                }
            }

            // Merge external state with runtime state
            const status = {
                ...externalState,
                buildId: BUILD_ID,
                browserHealth,
                recentErrors: externalState.recentErrors || state.recentErrors,
                activeSessions: Array.from(state.drivers.keys()),
                currentSession: state.currentSession,
                serverUptime: process.uptime()
            };

            // Format as readable text for agents
            let text = `## MCP Selenium Status\n\n`;
            text += `**Build:** ${BUILD_ID}\n`;
            text += `**Server Uptime:** ${Math.round(status.serverUptime)}s\n`;
            text += `**Active Sessions:** ${status.activeSessions.length ? status.activeSessions.join(', ') : 'None'}\n`;
            if (status.lastErrorUpdate) {
                text += `**Last Error:** ${status.lastErrorUpdate}\n`;
            }
            text += `\n`;

            text += `### Known Issues\n`;
            const activeIssues = (status.knownIssues || []).filter(i => i.active);
            if (activeIssues.length === 0) {
                text += `- No known issues\n`;
            } else {
                for (const issue of activeIssues) {
                    text += `- **[${issue.severity.toUpperCase()}]** ${issue.browser}: ${issue.description}\n`;
                    text += `  - Workaround: ${issue.workaround}\n`;
                }
            }

            text += `\n### Working Patterns\n`;
            for (const pattern of (status.workingPatterns || [])) {
                text += `- **${pattern.pattern}**: ${pattern.description}\n`;
                text += `  - Recommended: \`${pattern.recommended}\`\n`;
                text += `  - Avoid: ${pattern.avoid.map(a => `\`${a}\``).join(', ')}\n`;
            }

            if (status.notes && status.notes.length > 0) {
                text += `\n### Notes\n`;
                for (const note of status.notes) {
                    text += `- ${note}\n`;
                }
            }

            if (status.agentFeedback && status.agentFeedback.length > 0) {
                text += `\n### Agent Feedback (last ${Math.min(5, status.agentFeedback.length)})\n`;
                for (const fb of status.agentFeedback.slice(0, 5)) {
                    text += `- [${fb.type.toUpperCase()}${fb.browser && fb.browser !== 'all' ? `/${fb.browser}` : ''}] ${fb.message}\n`;
                }
                text += `  _(full history: /data/agent-feedback.jsonl)_\n`;
            }

            if (status.recentErrors && status.recentErrors.length > 0) {
                text += `\n### Recent Errors\n`;
                for (const err of status.recentErrors.slice(0, 5)) {
                    text += `- [${err.timestamp}] ${err.context}: ${err.message}\n`;
                }
            }

            return {
                content: [{ type: 'text', text }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting MCP status: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "close_session",
    "closes the current browser session",
    {},
    async () => {
        try {
            const key = getDriverKey();
            const driver = key ? state.drivers.get(key) : null;
            if (!driver) {
                return { content: [{ type: 'text', text: 'No active browser session to close' }] };
            }
            await driver.quit();
            state.drivers.delete(key);
            state.driverHealth.delete(key);
            lastToolSuccessAt.delete(key);
            // Only clear currentSession in STDIO mode
            if (!getMcpSessionId()) {
                state.currentSession = null;
                // Kill orphaned Chrome processes to prevent memory accumulation
                try {
                    const { execSync } = await import('child_process');
                    execSync('pkill -9 chromium || true', { stdio: 'ignore' });
                    execSync('pkill -9 chrome || true', { stdio: 'ignore' });
                    execSync('rm -rf /tmp/chrome-* /tmp/.org.chromium.* || true', { stdio: 'ignore' });
                } catch (e) { /* ignore */ }
            }
            debugLog(`Browser session closed: key=${key}, remaining=${state.drivers.size}`);
            return {
                content: [{ type: 'text', text: `Browser session ${key} closed. Remaining active: ${state.drivers.size}` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error closing session: ${e.message}` }]
            };
        }
    }
);

server.tool(
    "log_feedback",
    "Log agent observations, bugs, or working patterns so other agents can learn from them via get_mcp_status. Use this to share discoveries about what works or doesn't work with Selenium MCP.",
    {
        type: z.enum(['issue', 'pattern', 'note', 'resolve']).describe(
            "Type: 'issue' = bug/problem encountered, 'pattern' = working approach discovered, 'note' = general observation, 'resolve' = mark an existing issue as fixed"
        ),
        message: z.string().describe(
            "The feedback. For 'issue': describe the problem and workaround if known. For 'pattern': describe the working approach. For 'note': general observation. For 'resolve': describe what fixed it."
        ),
        severity: z.enum(['low', 'medium', 'high', 'blocker']).optional().describe(
            "Severity for 'issue' type only. Default: medium"
        ),
        issueId: z.string().optional().describe(
            "For 'resolve' type: the ID of the issue to deactivate (see get_mcp_status for IDs)"
        ),
        browser: z.string().optional().describe(
            "Browser this applies to: chrome, firefox, edge, or 'all'. Default: all"
        )
    },
    async ({ type, message, severity = 'medium', issueId, browser = 'all' }) => {
        try {
            const timestamp = new Date().toISOString();
            const entry = { timestamp, type, message, browser, severity: type === 'issue' ? severity : undefined };

            // Append to raw JSONL log (full history, never trimmed)
            try {
                fs.mkdirSync('/data', { recursive: true });
                fs.appendFileSync(FEEDBACK_LOG_FILE, JSON.stringify(entry) + '\n');
            } catch (e) {
                debugLog(`Failed to append to feedback log: ${e.message}`);
            }

            // Update structured state
            const externalState = readExternalState();
            externalState.agentFeedback = externalState.agentFeedback || [];
            externalState.agentFeedback.unshift(entry);
            if (externalState.agentFeedback.length > 50) {
                externalState.agentFeedback.pop();
            }

            if (type === 'issue') {
                const id = `agent-${Date.now()}`;
                externalState.knownIssues = externalState.knownIssues || [];
                externalState.knownIssues.unshift({
                    id,
                    browser,
                    severity,
                    description: message,
                    workaround: 'See agent-feedback.jsonl for context',
                    active: true,
                    reportedAt: timestamp
                });
            } else if (type === 'resolve' && issueId) {
                const issue = (externalState.knownIssues || []).find(i => i.id === issueId);
                if (issue) {
                    issue.active = false;
                    issue.resolvedAt = timestamp;
                    issue.resolution = message;
                }
            } else if (type === 'pattern') {
                externalState.workingPatterns = externalState.workingPatterns || [];
                externalState.workingPatterns.unshift({
                    pattern: `agent-${Date.now()}`,
                    description: message,
                    recommended: browser !== 'all' ? `(${browser} only)` : '(all browsers)',
                    avoid: [],
                    reportedAt: timestamp
                });
            } else if (type === 'note') {
                externalState.notes = externalState.notes || [];
                externalState.notes.unshift(`[${timestamp}] ${message}`);
                if (externalState.notes.length > 20) externalState.notes.pop();
            }

            writeExternalState(externalState);
            return {
                content: [{ type: 'text', text: `Feedback logged (${type}): "${message.slice(0, 80)}${message.length > 80 ? '…' : ''}"` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error logging feedback: ${e.message}` }]
            };
        }
    }
);

    return server;
}

// Resources removed — ResourceTemplate registration causes resources/list to throw
// "Cannot read properties of undefined (reading 'list')" in MCP SDK 1.20.x.
// Use the get_mcp_status tool instead, which exposes the same information.
void ResourceTemplate; // keep import reference live to avoid lint warnings

// Cleanup handler
async function cleanup() {
    for (const [sessionId, driver] of state.drivers) {
        try {
            await driver.quit();
        } catch (e) {
            console.error(`Error closing browser session ${sessionId}:`, e);
        }
    }
    state.drivers.clear();
    state.currentSession = null;
    process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Parse command line arguments
const args = process.argv.slice(2);
const transportMode = args.includes('--http') ? 'http' :
                      args.includes('--sse') ? 'sse' :
                      process.env.MCP_TRANSPORT || 'stdio';
const port = parseInt(process.env.MCP_PORT || '3000', 10);

// Start the server based on transport mode
if (transportMode === 'stdio') {
    // Standard stdio transport (default) — one process, one session, so a single
    // McpServer instance for the process lifetime is correct here.
    console.error(`Selenium MCP starting: build=${BUILD_ID} transport=${transportMode}`);
    const stdioServer = createMcpServer();
    const transport = new StdioServerTransport();
    await stdioServer.connect(transport);
} else if (transportMode === 'http') {
    console.log(`Selenium MCP starting: build=${BUILD_ID} transport=${transportMode}`);
    // Streamable HTTP transport (recommended for remote MCP servers)
    const app = express();
    app.use(cors());

    // Store one { server, transport, createdAt, lastSeenAt } entry per MCP session.
    // Each session gets its OWN McpServer instance — the SDK's Protocol.connect()
    // (node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js) overwrites
    // a single shared this._transport, so sharing one McpServer across sessions
    // caused cross-session response contamination and hangs. One server per session
    // avoids that entirely.
    const sessions = new Map();

    // Single MCP endpoint for all operations (Streamable HTTP)
    // NOTE: Do NOT use express.json() middleware before this route -
    // StreamableHTTPServerTransport needs to read the raw request stream
    app.all('/mcp', async (req, res) => {
        debugLog(`MCP request received: method=${req.method}`);
        const sessionId = req.headers['mcp-session-id'] || randomUUID();
        debugLog(`Session ID: ${sessionId}`);

        let session = sessions.get(sessionId);

        if (!session) {
            // Create a brand-new McpServer + transport dedicated to this session.
            const sessionServer = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId,
            });

            // Loud failure paths. These MUST be assigned before sessionServer.connect()
            // below: Protocol.connect() captures whatever onerror/onclose already sit on
            // the transport and wraps them (calls ours, then its own internal handler),
            // so setting them after connect() would silently replace — not augment —
            // the SDK's own cleanup logic.
            transport.onerror = (err) => {
                metrics.transportErrors++;
                console.error(`[TRANSPORT-ERROR] session=${sessionId}: ${err.message}`);
            };
            transport.onclose = () => {
                console.error(`[SESSION-CLOSED] session=${sessionId}`);
                sessions.delete(sessionId);
                const driver = state.drivers.get(sessionId);
                if (driver) {
                    driver.quit().catch((e) => console.error(`Error quitting driver for closed session ${sessionId}: ${e.message}`));
                    state.drivers.delete(sessionId);
                }
                state.driverHealth.delete(sessionId);
                lastToolSuccessAt.delete(sessionId);
                if (state.currentSession === sessionId) state.currentSession = null;
            };

            // Protocol-level errors (distinct from the transport-level errors above —
            // e.g. failure to send a response, or an unknown message type).
            sessionServer.server.onerror = (err) => {
                metrics.protocolErrors++;
                console.error(`[PROTOCOL-ERROR] session=${sessionId}: ${err.message}`);
            };

            session = { server: sessionServer, transport, createdAt: Date.now(), lastSeenAt: Date.now() };
            sessions.set(sessionId, session);

            // Explicitly echo session ID in response header so a load balancer
            // (e.g. HAProxy stick-table) can establish session affinity on first request
            res.setHeader('Mcp-Session-Id', sessionId);

            // Connect this session's own MCP server to its own transport
            await sessionServer.connect(transport);

            console.log(`New MCP session: ${sessionId} (build=${BUILD_ID})`);
        } else {
            session.lastSeenAt = Date.now();
        }

        const { transport } = session;

        // Misroute guard: under the old shared-server design, one session's transport
        // could silently receive another session's responses. Each session now owns
        // its own McpServer so this should never trip — kept as a loud regression
        // guard rather than a silent hang.
        if (transport.sessionId !== undefined && transport.sessionId !== sessionId) {
            metrics.misrouteGuardTrips++;
            console.error(`[MISROUTE-GUARD] map key=${sessionId} but transport.sessionId=${transport.sessionId}`);
            return res.status(500).json({ error: 'Session misroute detected', expectedSessionId: sessionId, transportSessionId: transport.sessionId });
        }

        // Handle the request within session context so tool handlers
        // can identify which MCP session is calling them
        try {
            await mcpSessionContext.run({ mcpSessionId: sessionId }, async () => {
                await transport.handleRequest(req, res);
            });
        } catch (err) {
            console.error('MCP request error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
        }
    });

    // JSON parsing for non-MCP routes
    app.use(express.json());

    // Background Chrome health checker — ONLY runs on idle sessions (no successful
    // tool call in the last 15s). This avoids false positives from executeScript
    // queuing behind an active navigate and timing out while Chrome is healthy.
    // Primary crash detection is reactive (via recordError pattern matching).
    // This background check catches the case where Chrome dies between tool calls.
    async function runIdleDriverHealthChecks() {
        const now = Date.now();
        for (const [key, driver] of state.drivers) {
            const lastSuccess = lastToolSuccessAt.get(key) || 0;
            if (now - lastSuccess < 15000) continue; // skip — session is active
            try {
                await Promise.race([
                    driver.executeScript('return 1'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
                ]);
                // Successful idle check — clear any prior unhealthy state
                const h = state.driverHealth.get(key);
                if (h && !h.healthy) {
                    state.driverHealth.set(key, { healthy: true, failCount: 0, checkedAt: now });
                    console.log(`Driver health recovered for ${key}`);
                }
                lastToolSuccessAt.set(key, now);
            } catch (e) {
                const prev = state.driverHealth.get(key) || { failCount: 0 };
                const failCount = prev.failCount + 1;
                state.driverHealth.set(key, { healthy: false, failCount, checkedAt: now, error: e.message });
                console.error(`Idle health check failed for ${key} (fail #${failCount}): ${e.message}`);
                // After 2 consecutive failures the session is unrecoverable — clean it up so
                // /health can return 200 again and the container re-enters HAProxy rotation.
                if (failCount >= 2) {
                    console.error(`Auto-cleanup: removing unrecoverable session ${key}`);
                    try { await driver.quit(); } catch {}
                    state.drivers.delete(key);
                    state.driverHealth.delete(key);
                    lastToolSuccessAt.delete(key);
                    if (state.currentSession === key) state.currentSession = null;
                }
            }
        }
        // Remove stale health entries for drivers that no longer exist
        for (const key of state.driverHealth.keys()) {
            if (!state.drivers.has(key)) state.driverHealth.delete(key);
        }
    }
    setInterval(runIdleDriverHealthChecks, 15000);

    // Health check endpoint — returns 503 if any active Chrome session has crashed
    // (2+ consecutive health check failures). HAProxy marks this backend DOWN on 503,
    // pulling it out of rotation until Chrome recovers or the session is closed.
    app.get('/health', (req, res) => {
        const sessionCount = sessions.size;
        const browserCount = state.drivers.size;
        const crashed = [];
        for (const [key, h] of state.driverHealth) {
            if (!h.healthy && h.failCount >= 2 && state.drivers.has(key)) {
                crashed.push({ session: key, failCount: h.failCount, error: h.error });
            }
        }
        const base = {
            status: crashed.length > 0 ? 'degraded' : 'ok',
            transport: 'streamable-http',
            buildId: BUILD_ID,
            sessions: sessionCount,
            browsers: browserCount,
            metrics: { ...metrics }
        };
        if (crashed.length > 0) {
            return res.status(503).json({ ...base, crashed });
        }
        res.json(base);
    });

    app.listen(port, '0.0.0.0', () => {
        console.log(`Selenium MCP server running on http://0.0.0.0:${port} (streamable-http transport)`);
        console.log(`  MCP endpoint: http://0.0.0.0:${port}/mcp`);
        console.log(`  Health check: http://0.0.0.0:${port}/health`);
    });
} else {
    console.error(`Unknown transport mode: ${transportMode}`);
    process.exit(1);
}