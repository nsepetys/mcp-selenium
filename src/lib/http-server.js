import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { SeleniumServer } from './selenium-server.js';

// Create the Selenium instance
const seleniumServer = new SeleniumServer();

// Create an MCP server
const server = new McpServer({
    name: "MCP Selenium",
    version: "0.2.0"
});

// Common schemas
const browserOptionsSchema = z.object({
    headless: z.boolean().optional(),
    arguments: z.array(z.string()).optional()
});

const locatorSchema = {
    by: z.enum(["id", "css", "xpath", "name", "tag", "class"]),
    value: z.string(),
    timeout: z.number().optional()
};

// Browser Management Tools
server.tool(
    "start_browser",
    {
        browser: z.enum(["chrome", "firefox"]),
        options: browserOptionsSchema.optional()
    },
    async ({ browser, options = {} }) => {
        const result = await Promise.race([
            seleniumServer.startBrowser(browser, options),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Browser startup is taking longer than expected. This is normal for first-time setup as drivers are being downloaded.')), 120000)
            )
        ]);
        return {
            content: result.content,
            metadata: { session_id: result.session_id }
        };
    }
);

server.tool(
    "navigate",
    {
        url: z.string().url()
    },
    async ({ url }) => {
        const result = await seleniumServer.navigate(url);
        return { content: result.content };
    }
);

// Basic Element Interaction Tools
server.tool(
    "find_element",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.findElement(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "click_element",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.clickElement(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "send_keys",
    {
        ...locatorSchema,
        text: z.string()
    },
    async ({ by, value, text, timeout }) => {
        const result = await seleniumServer.sendKeys(by, value, text, timeout);
        return { content: result.content };
    }
);

server.tool(
    "send_special_key",
    {
        ...locatorSchema,
        keyName: z.enum([
            'enter', 'return', 'tab', 'escape', 'space',
            'backspace', 'delete',
            'up', 'down', 'left', 'right',
            'pageup', 'pagedown', 'home', 'end'
        ])
    },
    async ({ by, value, keyName, timeout }) => {
        const result = await seleniumServer.sendSpecialKey(by, value, keyName, timeout);
        return { content: result.content };
    }
);

server.tool(
    "clear_element",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.clearElement(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "get_element_text",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.getElementText(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "get_element_attribute",
    {
        ...locatorSchema,
        attribute: z.string()
    },
    async ({ by, value, attribute, timeout }) => {
        const result = await seleniumServer.getElementAttribute(by, value, attribute, timeout);
        return { content: result.content };
    }
);

// Advanced Mouse Interaction Tools
server.tool(
    "double_click",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.doubleClick(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "right_click",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.rightClick(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "hover",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.hover(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "drag_and_drop",
    {
        sourceBy: z.enum(["id", "css", "xpath", "name", "tag", "class"]),
        sourceValue: z.string(),
        targetBy: z.enum(["id", "css", "xpath", "name", "tag", "class"]),
        targetValue: z.string(),
        timeout: z.number().optional()
    },
    async ({ sourceBy, sourceValue, targetBy, targetValue, timeout }) => {
        const result = await seleniumServer.dragAndDrop(sourceBy, sourceValue, targetBy, targetValue, timeout);
        return { content: result.content };
    }
);

// File Upload Tool
server.tool(
    "upload_file",
    {
        ...locatorSchema,
        filePath: z.string()
    },
    async ({ by, value, filePath, timeout }) => {
        const result = await seleniumServer.uploadFile(by, value, filePath, timeout);
        return { content: result.content };
    }
);

// Frame Management Tools
server.tool(
    "switch_to_frame",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.switchToFrame(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "switch_to_default_content",
    {},
    async () => {
        const result = await seleniumServer.switchToDefaultContent();
        return { content: result.content };
    }
);

// Alert Handling Tools
server.tool(
    "accept_alert",
    {},
    async () => {
        const result = await seleniumServer.acceptAlert();
        return { content: result.content };
    }
);

server.tool(
    "dismiss_alert",
    {},
    async () => {
        const result = await seleniumServer.dismissAlert();
        return { content: result.content };
    }
);

server.tool(
    "get_alert_text",
    {},
    async () => {
        const result = await seleniumServer.getAlertText();
        return { content: result.content };
    }
);

// Clipboard Operation Tools
server.tool(
    "copy_text",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.copyText(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "paste_text",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.pasteText(by, value, timeout);
        return { content: result.content };
    }
);

server.tool(
    "cut_text",
    locatorSchema,
    async ({ by, value, timeout }) => {
        const result = await seleniumServer.cutText(by, value, timeout);
        return { content: result.content };
    }
);

// Browser Status Resource
server.resource(
    "browser-status",
    "browser-status://current",
    async (uri) => ({
        contents: [{
            uri: uri.href,
            text: seleniumServer.currentSession
                ? `Active browser session: ${seleniumServer.currentSession}`
                : "No active browser session"
        }]
    })
);

// Handle cleanup
async function cleanup() {
    await seleniumServer.cleanup();
    process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Session management for Streamable HTTP
const transports = {};

// Helper to check if request is initialize
function isInitializeRequest(body) {
    return body && body.method === 'initialize';
}

// Mount MCP endpoint
app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    // Handle new session (initialize request)
    if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (newSessionId) => {
                transports[newSessionId] = transport;
                console.log(`New MCP session initialized: ${newSessionId}`);
            }
        });

        await server.connect(transport);

        // Set proper headers for StreamableHTTP
        if (!req.headers.accept || !req.headers.accept.includes('text/event-stream')) {
            req.headers.accept = 'application/json, text/event-stream';
        }

        await transport.handleRequest(req, res, req.body);
        return;
    }

    // Handle existing session
    if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
        return;
    }

    // Session not found
    res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Invalid or missing session' },
        id: null
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'selenium-mcp',
        hasActiveBrowser: !!seleniumServer.currentSession
    });
});

// Start HTTP server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Selenium MCP HTTP server listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
