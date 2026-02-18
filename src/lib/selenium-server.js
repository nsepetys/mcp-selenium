import pkg from 'selenium-webdriver';
const { Builder, By, Key, until } = pkg;
import chrome from 'selenium-webdriver/chrome.js';
import firefox from 'selenium-webdriver/firefox.js';
import { Options as ChromeOptions } from 'selenium-webdriver/chrome.js';
import { Options as FirefoxOptions } from 'selenium-webdriver/firefox.js';
import crypto from 'crypto';
import fs from 'fs';

// Debug logging to file (since console.error may not appear in docker logs)
const DEBUG_LOG = '/tmp/selenium-debug.log';
function debugLog(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    fs.appendFileSync(DEBUG_LOG, line);
    console.error(msg);
}

export class SeleniumServer {
    constructor() {
        this.drivers = new Map();
        this.currentSession = null;
    }

    async startBrowser(browser, options = {}) {
        console.error(`[DEBUG] startBrowser called with browser=${browser}, options=${JSON.stringify(options)}`);
        try {
            let builder = new Builder();
            let driver;

            // Generate session ID early so we can use it for unique user-data-dir
            // Use UUID fragment for guaranteed uniqueness
            const uuidFragment = crypto.randomUUID().split('-')[0];
            const sessionId = `${browser}_${Date.now()}_${uuidFragment}`;

            // Send initial status message
            this._sendProgress('Initializing browser session...');

            // Check for remote Selenium server
            const remoteUrl = process.env.SELENIUM_REMOTE_URL;
            if (remoteUrl) {
                this._sendProgress(`Connecting to remote Selenium server: ${remoteUrl}`);
                builder = builder.usingServer(remoteUrl);
            }

            if (browser === 'chrome') {
                const chromeOptions = new ChromeOptions();
                if (options.headless) {
                    chromeOptions.addArguments('--headless=new');
                }

                // Add unique user-data-dir to avoid conflicts when multiple browsers run
                chromeOptions.addArguments(`--user-data-dir=/tmp/chrome-${sessionId}`);
                // Add additional flags needed for Chrome in containers
                chromeOptions.addArguments('--disable-dev-shm-usage');
                chromeOptions.addArguments('--no-sandbox');
                chromeOptions.addArguments('--disable-gpu');
                chromeOptions.addArguments('--disable-software-rasterizer');
                chromeOptions.addArguments('--disable-extensions');
                chromeOptions.addArguments('--disable-setuid-sandbox');
                // Prevent Chrome from trying to connect to Google services (critical for proxy environments)
                chromeOptions.addArguments('--disable-background-networking');
                chromeOptions.addArguments('--disable-client-side-phishing-detection');
                chromeOptions.addArguments('--disable-default-apps');
                chromeOptions.addArguments('--disable-sync');
                chromeOptions.addArguments('--disable-translate');
                chromeOptions.addArguments('--metrics-recording-only');
                chromeOptions.addArguments('--no-first-run');
                chromeOptions.addArguments('--safebrowsing-disable-auto-update');
                chromeOptions.addArguments('--disable-component-update');
                chromeOptions.addArguments('--disable-domain-reliability');
                chromeOptions.addArguments('--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints,Translate,MediaRouter,TranslateUI');
                chromeOptions.addArguments('--disable-hang-monitor');
                chromeOptions.addArguments('--disable-popup-blocking');
                chromeOptions.addArguments('--disable-prompt-on-repost');
                chromeOptions.addArguments('--disable-renderer-backgrounding');
                chromeOptions.addArguments('--force-color-profile=srgb');
                chromeOptions.addArguments('--no-default-browser-check');
                // Allow access to localhost/loopback addresses
                chromeOptions.addArguments('--allow-insecure-localhost');
                chromeOptions.addArguments('--allow-loopback-in-peer-connection');
                // Disable network namespace isolation that might block loopback
                chromeOptions.addArguments('--disable-features=NetworkServiceSandbox');
                // Additional flags to help with localhost access
                chromeOptions.addArguments('--remote-allow-origins=*');
                chromeOptions.addArguments('--disable-web-security');
                // Map localhost hostname to host.docker.internal IP
                // Note: This only works for hostname "localhost", not IP "127.0.0.1"
                chromeOptions.addArguments('--host-resolver-rules=MAP localhost 192.168.65.254');

                if (options.arguments) {
                    options.arguments.forEach(arg => chromeOptions.addArguments(arg));
                }

                // Configure proxy explicitly via WebDriver for Chrome
                // Chrome via WebDriver doesn't properly route localhost/127.0.0.1 through env var proxy
                const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
                if (proxyUrl) {
                    const proxyMatch = proxyUrl.match(/https?:\/\/([^:]+):(\d+)/);
                    if (proxyMatch) {
                        const proxyHost = proxyMatch[1];
                        const proxyPort = parseInt(proxyMatch[2]);
                        // Use PAC script to force ALL traffic through proxy including localhost
                        // This is necessary because Chrome normally bypasses proxy for loopback addresses
                        const pacScript = `function FindProxyForURL(url, host) { return "PROXY ${proxyHost}:${proxyPort}"; }`;
                        chromeOptions.addArguments(`--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacScript).toString('base64')}`);
                        console.error(`✓ Configured Chrome proxy via PAC: ${proxyHost}:${proxyPort} (all traffic including localhost)`);
                    }
                } else {
                    console.error('✓ No proxy configured (HTTP_PROXY not set)');
                }

                this._sendProgress('Setting up Chrome driver (this may take a moment on first run)...');

                // Set ChromeDriver path if available
                if (process.env.CHROMEDRIVER_PATH) {
                    const chromeService = new chrome.ServiceBuilder(process.env.CHROMEDRIVER_PATH);
                    driver = await builder
                        .forBrowser('chrome')
                        .setChromeOptions(chromeOptions)
                        .setChromeService(chromeService)
                        .build();
                } else {
                    driver = await builder
                        .forBrowser('chrome')
                        .setChromeOptions(chromeOptions)
                        .build();
                }
            } else if (browser === 'firefox') {
                debugLog('=== Starting Firefox setup ===');
                const firefoxOptions = new FirefoxOptions();

                // Set Firefox binary path - check environment variable or use Selenium Manager's cached location
                const firefoxBin = process.env.FIREFOX_BIN || '/root/.cache/selenium/firefox/linux64/147.0.2/firefox';
                debugLog(`Setting Firefox binary to: ${firefoxBin}`);
                firefoxOptions.setBinary(firefoxBin);
                debugLog(`✓ Firefox binary set`);

                if (options.headless) {
                    firefoxOptions.addArguments('-headless');
                    debugLog('✓ Headless mode enabled');
                }

                // Disable sandbox for container environments
                firefoxOptions.setPreference('security.sandbox.content.level', 0);
                debugLog('✓ Sandbox disabled');

                // Disable various Firefox features that cause issues in containers
                firefoxOptions.setPreference('toolkit.cosmeticAnimations.enabled', false);
                firefoxOptions.setPreference('media.hardware-video-decoding.enabled', false);

                // Allow Firefox to bypass proxy for localhost - socat handles forwarding to host
                // Firefox can't properly proxy localhost, so let it connect directly to socat
                firefoxOptions.setPreference('network.proxy.no_proxies_on', 'localhost, 127.0.0.1');
                firefoxOptions.setPreference('network.proxy.allow_hijacking_localhost', true);
                debugLog('✓ Localhost proxy bypass enabled (socat handles forwarding)');

                if (options.arguments) {
                    options.arguments.forEach(arg => firefoxOptions.addArguments(arg));
                }

                // Configure proxy if HTTP_PROXY is set
                // Use Firefox native preferences for PAC proxy to force ALL traffic including localhost
                const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
                debugLog(`HTTP_PROXY env var: ${proxyUrl}`);
                if (proxyUrl) {
                    const proxyMatch = proxyUrl.match(/https?:\/\/([^:]+):(\d+)/);
                    debugLog(`Proxy regex match result: ${JSON.stringify(proxyMatch)}`);
                    if (proxyMatch) {
                        const proxyHost = proxyMatch[1];
                        const proxyPort = parseInt(proxyMatch[2]);
                        // PAC script that routes traffic through proxy, EXCEPT localhost (socat handles that)
                        // Security: localhost can only reach socat in container, not bypass proxy for internet
                        const pacScript = `function FindProxyForURL(url, host) { if (host === 'localhost' || host === '127.0.0.1') return 'DIRECT'; return "PROXY ${proxyHost}:${proxyPort}"; }`;
                        const pacUrl = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacScript).toString('base64')}`;

                        debugLog(`PAC script: ${pacScript}`);
                        debugLog(`PAC URL: ${pacUrl}`);

                        // Set proxy via Firefox native preferences (type 2 = PAC)
                        // This is more reliable than the WebDriver proxy API
                        firefoxOptions.setPreference('network.proxy.type', 2);
                        firefoxOptions.setPreference('network.proxy.autoconfig_url', pacUrl);
                        debugLog(`✓ Configured Firefox proxy via native prefs PAC: ${proxyHost}:${proxyPort}`);
                    } else {
                        debugLog('✗ Proxy URL did not match regex pattern');
                    }
                } else {
                    debugLog('✗ No HTTP_PROXY env var found');
                }

                this._sendProgress('Setting up Firefox driver (this may take a moment on first run)...');

                // Use geckodriver from Selenium Manager cache
                const geckodriverPath = process.env.GECKODRIVER_PATH || '/root/.cache/selenium/geckodriver/linux64/0.36.0/geckodriver';
                debugLog(`Using geckodriver: ${geckodriverPath}`);
                const firefoxService = new firefox.ServiceBuilder(geckodriverPath);

                // Log the Firefox options for debugging
                debugLog(`FirefoxOptions object created, about to build driver...`);

                debugLog('Building Firefox driver...');
                try {
                    driver = await builder
                        .forBrowser('firefox')
                        .setFirefoxOptions(firefoxOptions)
                        .setFirefoxService(firefoxService)
                        .build();
                    debugLog('✓ Firefox driver built successfully');
                    console.error('Firefox driver built successfully');
                } catch (buildError) {
                    console.error(`Firefox driver build failed: ${buildError.message}`);
                    console.error(`Stack: ${buildError.stack}`);
                    throw buildError;
                }
            } else {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Unsupported browser: ${browser}`
                        }
                    ],
                    isError: true
                };
            }

            this.drivers.set(sessionId, driver);
            this.currentSession = sessionId;

            this._sendProgress('Browser session started successfully!');

            return {
                content: [
                    {
                        type: 'text',
                        text: `Browser started with session_id: ${sessionId}`
                    }
                ],
                session_id: sessionId,
                isError: false
            };
        } catch (e) {
            console.error('Error starting browser:', e);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error starting browser: ${e.message}`
                    }
                ],
                isError: true
            };
        }
    }

    _sendProgress(message) {
        console.error(message);
    }

    async navigate(url) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            await driver.get(url);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Navigated to ${url}`
                    }
                ],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error navigating to URL', e);
        }
    }

    async findElement(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Element found'
                    }
                ],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error finding element', e);
        }
    }

    async clickElement(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await element.click();
            
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Element clicked'
                    }
                ],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error clicking element', e);
        }
    }

    async sendKeys(by, value, text, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await element.clear();
            await element.sendKeys(text);
            
            return {
                content: [
                    {
                        type: 'text',
                        text: `Text "${text}" entered into element`
                    }
                ],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error entering text', e);
        }
    }

    async sendSpecialKey(by, value, keyName, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            
            // Map common key names to Selenium Key values
            const keyMap = {
                'enter': Key.ENTER,
                'return': Key.RETURN,
                'tab': Key.TAB,
                'escape': Key.ESCAPE,
                'space': Key.SPACE,
                'backspace': Key.BACK_SPACE,
                'delete': Key.DELETE,
                'up': Key.ARROW_UP,
                'down': Key.ARROW_DOWN,
                'left': Key.ARROW_LEFT,
                'right': Key.ARROW_RIGHT,
                'pageup': Key.PAGE_UP,
                'pagedown': Key.PAGE_DOWN,
                'home': Key.HOME,
                'end': Key.END
            };

            const keyToSend = keyMap[keyName.toLowerCase()];
            if (!keyToSend) {
                throw new Error(`Unsupported special key: ${keyName}`);
            }

            await element.sendKeys(keyToSend);
            
            return {
                content: [{ 
                    type: 'text', 
                    text: `Sent ${keyName} key to element`
                }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error sending special key', e);
        }
    }

    async clearElement(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await element.clear();
            
            return {
                content: [{ type: 'text', text: 'Element cleared' }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error clearing element', e);
        }
    }

    async getElementText(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const text = await element.getText();
            
            return {
                content: [{ type: 'text', text }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error getting element text', e);
        }
    }

    async getElementAttribute(by, value, attribute, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const attributeValue = await element.getAttribute(attribute);
            
            return {
                content: [{ type: 'text', text: attributeValue || '' }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error getting element attribute', e);
        }
    }

    async isElementSelected(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const isSelected = await element.isSelected();
            
            return {
                content: [{ 
                    type: 'text', 
                    text: String(isSelected) 
                }],
                isError: false,
                state: isSelected
            };
        } catch (e) {
            return this._handleError('Error checking if element is selected', e);
        }
    }

    async isElementEnabled(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const isEnabled = await element.isEnabled();
            
            return {
                content: [{ 
                    type: 'text', 
                    text: String(isEnabled)
                }],
                isError: false,
                state: isEnabled
            };
        } catch (e) {
            return this._handleError('Error checking if element is enabled', e);
        }
    }

    async isElementDisplayed(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const isDisplayed = await element.isDisplayed();
            
            return {
                content: [{ 
                    type: 'text', 
                    text: String(isDisplayed)
                }],
                isError: false,
                state: isDisplayed
            };
        } catch (e) {
            return this._handleError('Error checking if element is displayed', e);
        }
    }

    async selectCheckboxIfNotSelected(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const isSelected = await element.isSelected();
            
            if (!isSelected) {
                await element.click();
                return {
                    content: [{ 
                        type: 'text', 
                        text: 'Checkbox was unchecked and has been selected'
                    }],
                    isError: false
                };
            }
            
            return {
                content: [{ 
                    type: 'text', 
                    text: 'Checkbox was already selected, no action needed'
                }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error handling checkbox selection', e);
        }
    }

    async unselectCheckboxIfSelected(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const isSelected = await element.isSelected();
            
            if (isSelected) {
                await element.click();
                return {
                    content: [{ 
                        type: 'text', 
                        text: 'Checkbox was checked and has been unselected'
                    }],
                    isError: false
                };
            }
            
            return {
                content: [{ 
                    type: 'text', 
                    text: 'Checkbox was already unselected, no action needed'
                }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error handling checkbox unselection', e);
        }
    }

    async dragAndDrop(sourceBy, sourceValue, targetBy, targetValue, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const sourceLocator = this._getLocator(sourceBy, sourceValue);
            const targetLocator = this._getLocator(targetBy, targetValue);
            
            const sourceElement = await driver.wait(until.elementLocated(sourceLocator), timeout);
            const targetElement = await driver.wait(until.elementLocated(targetLocator), timeout);
            
            const actions = driver.actions({ bridge: true });
            await actions.dragAndDrop(sourceElement, targetElement).perform();
            
            return {
                content: [{ type: 'text', text: 'Dragged and dropped element' }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error performing drag and drop', e);
        }
    }

    async dragAndDropByOffset(sourceBy, sourceValue, xOffset, yOffset, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const sourceLocator = this._getLocator(sourceBy, sourceValue);
            const sourceElement = await driver.wait(until.elementLocated(sourceLocator), timeout);
            
            const actions = driver.actions({ bridge: true });
            await actions
                .dragAndDrop(sourceElement, { x: xOffset, y: yOffset })
                .perform();
            
            return {
                content: [{ type: 'text', text: `Dragged element by offset: x=${xOffset}, y=${yOffset}` }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error performing drag and drop by offset', e);
        }
    }

    async copyText(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            
            // Select all text
            const platform = process.platform;
            const cmdKey = platform === 'darwin' ? Key.COMMAND : Key.CONTROL;
            
            await element.click();
            const actions = driver.actions({ bridge: true });
            await actions
                .keyDown(cmdKey)
                .sendKeys('a')
                .keyUp(cmdKey)
                .keyDown(cmdKey)
                .sendKeys('c')
                .keyUp(cmdKey)
                .perform();
            
            return {
                content: [{ type: 'text', text: 'Text copied to clipboard' }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error copying text', e);
        }
    }

    async pasteText(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            
            // Paste text
            const platform = process.platform;
            const cmdKey = platform === 'darwin' ? Key.COMMAND : Key.CONTROL;
            
            await element.click();
            const actions = driver.actions({ bridge: true });
            await actions
                .keyDown(cmdKey)
                .sendKeys('v')
                .keyUp(cmdKey)
                .perform();
            
            return {
                content: [{ type: 'text', text: 'Text pasted from clipboard' }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error pasting text', e);
        }
    }

    async cutText(by, value, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            
            // Cut text
            const platform = process.platform;
            const cmdKey = platform === 'darwin' ? Key.COMMAND : Key.CONTROL;
            
            await element.click();
            const actions = driver.actions({ bridge: true });
            await actions
                .keyDown(cmdKey)
                .sendKeys('a')
                .keyUp(cmdKey)
                .keyDown(cmdKey)
                .sendKeys('x')
                .keyUp(cmdKey)
                .perform();
            
            return {
                content: [{ type: 'text', text: 'Text cut to clipboard' }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error cutting text', e);
        }
    }

    async sendKeyboardShortcut(by, value, keys, timeout = 10000) {
        try {
            const driver = this.drivers.get(this.currentSession);
            if (!driver) {
                return this._noSessionError();
            }

            const locator = this._getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            
            await element.click();
            const actions = driver.actions({ bridge: true });
            
            // Handle array of keys for combinations
            if (Array.isArray(keys)) {
                // Press all keys in sequence
                for (const key of keys) {
                    await actions.keyDown(key);
                }
                // Release all keys in reverse order
                for (const key of keys.reverse()) {
                    await actions.keyUp(key);
                }
            } else {
                // Single key
                await actions.keyDown(keys).keyUp(keys);
            }
            
            await actions.perform();
            
            return {
                content: [{ type: 'text', text: 'Keyboard shortcut sent' }],
                isError: false
            };
        } catch (e) {
            return this._handleError('Error sending keyboard shortcut', e);
        }
    }

    _getLocator(by, value) {
        switch (by.toLowerCase()) {
            case 'id':
                return By.id(value);
            case 'css':
                return By.css(value);
            case 'xpath':
                return By.xpath(value);
            case 'name':
                return By.name(value);
            case 'tag':
                return By.tagName(value);
            case 'class':
                return By.className(value);
            default:
                throw new Error(`Unsupported locator strategy: ${by}`);
        }
    }

    _noSessionError() {
        return {
            content: [{ type: 'text', text: 'No active browser session' }],
            isError: true
        };
    }

    _handleError(message, error) {
        console.error(`${message}:`, error);
        return {
            content: [{ type: 'text', text: `${message}: ${error.message}` }],
            isError: true
        };
    }

    async cleanup() {
        console.error('Cleaning up browser sessions...');
        for (const [sessionId, driver] of this.drivers) {
            try {
                await driver.quit();
                console.error(`Closed browser session: ${sessionId}`);
            } catch (e) {
                console.error(`Error closing browser session ${sessionId}:`, e);
            }
        }
        this.drivers.clear();
        this.currentSession = null;
    }
}