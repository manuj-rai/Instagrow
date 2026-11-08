// Chrome driver lifecycle. Either attaches to an existing Chrome via remote
// debugging port, or launches a fresh one.

const { Builder } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const { log, logError } = require("../state");

async function buildDriver({
  chromeUserDataDir,
  chromeProfileDir,
  pageLoadTimeoutMs,
  useRemoteDebugging,
  remoteDebuggingPort,
}) {
  const options = new chrome.Options();
  // "eager": driver.get() returns at DOMContentLoaded instead of waiting for
  // every image/video on the page (the default "normal" made each profile
  // switch take 10–100s on media-heavy profiles). Our own readiness checks
  // (waitForProfileReady / jsFindAndClick) wait for the elements we need.
  options.setPageLoadStrategy("eager");

  if (useRemoteDebugging) {
    const debuggerAddress = `127.0.0.1:${remoteDebuggingPort}`;
    log(`🔌 Connecting to existing Chrome at ${debuggerAddress}...`);
    log(`   (Make sure run.bat is launching Chrome on this port first!)`);
    options.debuggerAddress(debuggerAddress);
  } else {
    log(`🚀 Launching new Chrome instance...`);
    log(`   (This requires all Chrome windows to be closed!)`);

    options.addArguments("--no-first-run");
    options.addArguments("--no-default-browser-check");
    options.addArguments("--disable-notifications");
    options.addArguments("--disable-infobars");
    options.addArguments("--disable-dev-shm-usage");
    options.addArguments("--no-sandbox");
    options.addArguments("--disable-gpu");
    options.addArguments("--disable-blink-features=AutomationControlled");
    options.excludeSwitches("enable-automation");
    options.addArguments("--disable-hang-monitor");
    options.addArguments("--disable-prompt-on-repost");
    options.addArguments("--disable-background-timer-throttling");
    options.addArguments("--disable-backgrounding-occluded-windows");
    options.addArguments("--disable-renderer-backgrounding");
    options.addArguments(
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
    );

    if (chromeUserDataDir) {
      options.addArguments(`--user-data-dir=${chromeUserDataDir}`);
      log(`📁 Using Chrome profile: ${chromeUserDataDir}`);
    }
    if (chromeProfileDir) {
      options.addArguments(`--profile-directory=${chromeProfileDir}`);
      log(`📁 Using profile directory: ${chromeProfileDir}`);
    }
  }

  const startAttempt = Date.now();
  let driver;
  try {
    driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(options)
      .build();
    log(`✓ Chrome connected successfully (${Date.now() - startAttempt}ms)`);
  } catch (buildErr) {
    logError(`❌ Chrome connection failed after ${Date.now() - startAttempt}ms`, buildErr);
    if (useRemoteDebugging && /connect/.test(buildErr.message)) {
      logError(
        `⚠️  Could not connect to Chrome on port ${remoteDebuggingPort}`,
        new Error(
          `Use run.bat to launch Chrome with the debug port before starting this server. ` +
          `Verify Chrome is running by visiting http://localhost:${remoteDebuggingPort}`
        )
      );
    }
    if (/DevToolsActivePort/.test(buildErr.message)) {
      logError(
        "⚠️  DevToolsActivePort error",
        new Error("Close all Chrome windows and run run.bat again.")
      );
    }
    throw buildErr;
  }

  await driver.manage().setTimeouts({
    pageLoad: pageLoadTimeoutMs,
    script: pageLoadTimeoutMs,
    implicit: 0, // we manage waits ourselves
  });

  if (!useRemoteDebugging) {
    log("✓ Disabling webdriver detection...");
    await driver.executeScript(
      "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    );
  }

  log("✅ Chrome browser ready");
  return driver;
}

module.exports = { buildDriver };
