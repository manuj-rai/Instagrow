// Shared driver-session wrapper used by every job. Handles:
//   - "is another job running?" guard
//   - resetRun / endRun bookkeeping
//   - building the driver, navigating to instagram.com, login check
//   - cleanup (driver.quit or disconnect)
//   - try/catch + log of fatal errors

const { sleep } = require("../utils");
const { state, log, logError, resetRun, endRun } = require("../state");
const { LOGIN_WAIT_MS } = require("../constants");
const { buildDriver, checkLoginStatus } = require("../selenium");

let stopRequestedListener = null;

function requestStop() {
  state.stopRequested = true;
  log("⏹️  Stop requested via API");
}

async function connectAndVerifyLogin(config) {
  const driver = await buildDriver(config);

  log("Navigating to Instagram...");
  await driver.get(config.baseUrl);
  await sleep(2000);

  if (!(await checkLoginStatus(driver))) {
    log("⚠️  Not logged in. Waiting 60s for manual login...", "warn");
    await sleep(LOGIN_WAIT_MS);
    if (!(await checkLoginStatus(driver))) {
      throw new Error("Not logged in to Instagram.");
    }
  }
  log("✅ Login verified.");
  return driver;
}

/**
 * Runs `body(driver, { reconnect })` inside a managed Selenium session.
 * `reconnect()` re-attaches to Chrome after the session is lost (browser
 * closed / restarted) and resolves to the new driver. Returns the body's
 * return value, or { ok: false, error } on failure.
 */
async function withDriverSession({ jobType, total, jobName, config, body }) {
  if (state.running) {
    return { ok: false, message: "A run is already in progress" };
  }

  resetRun(total, jobType);
  log(`🚀 Starting ${jobName}`);
  if (config.dryRun) log("🔵 DRY RUN MODE — no IG actions will be performed");

  let driver;
  const reconnect = async () => {
    log("🔄 Lost connection to Chrome — reconnecting...", "warn");
    if (driver && !config.useRemoteDebugging) {
      try { await driver.quit(); } catch {}
    }
    driver = null;
    driver = await connectAndVerifyLogin(config);
    return driver;
  };

  try {
    driver = await connectAndVerifyLogin(config);
    return await body(driver, { reconnect });
  } catch (err) {
    logError(`Fatal error in ${jobName}`, err);
    return { ok: false, error: err.message };
  } finally {
    try {
      if (driver) {
        if (config.useRemoteDebugging) {
          log("🔌 Disconnecting from Chrome (browser stays open)");
        } else {
          await driver.quit();
          log("Browser closed");
        }
      }
    } catch (cleanupErr) {
      logError("Error closing browser", cleanupErr);
    }
    endRun(
      `${jobName} finished. Successes: ${state.successes}, Failures: ${state.failures}, ` +
      `Daily: ${state.dailyCount}/${config.dailyLimit}`
    );
  }
}

module.exports = { withDriverSession, requestStop };
