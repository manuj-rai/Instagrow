// JS-based DOM helpers. We use executeScript (not WebDriver's native click/find)
// so they keep working when Chrome is unfocused or backgrounded.

const { sleep } = require("../utils");

/**
 * Try each xpath until one matches, then click it. Polls every 80ms until
 * timeoutMs elapses. Returns { found, xpath, text } or { found: false }.
 */
async function jsFindAndClick(driver, xpaths, timeoutMs) {
  const startTime = Date.now();

  const tryClickScript = function (xpathList) {
    for (const xp of xpathList) {
      const result = document.evaluate(
        xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      const el = result.singleNodeValue;
      if (el) {
        el.click();
        return {
          found: true,
          xpath: xp,
          text: (el.textContent || "").trim().slice(0, 40),
        };
      }
    }
    return { found: false };
  };

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await driver.executeScript(tryClickScript, xpaths);
      if (result && result.found) return result;
    } catch {
      // page navigating — retry
    }
    await sleep(80);
  }
  return { found: false };
}

/** True if any of the given xpaths matches an element. */
async function jsElementExists(driver, xpaths) {
  const script = function (xpathList) {
    for (const xp of xpathList) {
      const result = document.evaluate(
        xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      if (result.singleNodeValue) return true;
    }
    return false;
  };
  try {
    return await driver.executeScript(script, xpaths);
  } catch {
    return false;
  }
}

/** Polls until a `div[role="dialog"]` appears, or timeout. */
async function waitForDialog(driver, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const exists = await driver.executeScript(function () {
        return !!document.querySelector('div[role="dialog"]');
      });
      if (exists) return true;
    } catch {
      // navigating
    }
    await sleep(200);
  }
  return false;
}

/**
 * Loose readiness check for IG profile pages. Any single signal is enough,
 * so it doesn't break when IG tweaks the DOM.
 */
async function waitForProfileReady(driver, timeoutMs) {
  const startTime = Date.now();

  const checkScript = function () {
    var pageText = (document.body && document.body.innerText) || "";

    if (
      pageText.indexOf("Sorry, this page") !== -1 ||
      pageText.indexOf("Page Not Found") !== -1
    ) {
      return { ready: false, isError: true };
    }

    var xpaths = [
      "//div[@role='button'][contains(., 'Follow')]",
      "//div[@role='button'][contains(., 'Requested')]",
      "//button[contains(., 'Follow')]",
    ];
    for (var i = 0; i < xpaths.length; i++) {
      var r = document.evaluate(xpaths[i], document, null, 9, null);
      if (r.singleNodeValue) return { ready: true };
    }

    if (/followers/i.test(pageText) && /following/i.test(pageText)) {
      return { ready: true };
    }

    if (
      document.querySelector("header section") ||
      (document.querySelector("header") &&
        document.querySelectorAll("header ul li").length > 0)
    ) {
      return { ready: true };
    }

    return { ready: false };
  };

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await driver.executeScript(checkScript);
      if (result.isError) return { ready: false, error: "Profile not found (404)" };
      if (result.ready) return { ready: true };
    } catch {
      // page still loading
    }
    await sleep(100);
  }
  return { ready: false, error: "Profile page did not become interactive in time" };
}

/** True when the WebDriver session / Chrome connection is gone (not a page problem). */
function isSessionLost(err) {
  const msg = (err && err.message) || "";
  return /invalid session id|session deleted|no such window|target window already closed|chrome not reachable|disconnected|ECONNREFUSED|ECONNRESET/i.test(msg);
}

/**
 * Navigates to a profile and waits until it's interactive. A page-load timeout
 * isn't fatal: IG keeps loading media long after the profile is usable, so we
 * stop the load and carry on — but only if the browser actually reached the
 * target profile (never act on the previous page). Session loss is re-thrown.
 */
async function openProfile(driver, baseUrl, username, timeoutMs) {
  try {
    await driver.get(`${baseUrl}/${username}/`);
  } catch (err) {
    if (isSessionLost(err) || !/time(d)? ?out/i.test(err.message || "")) throw err;
    try { await driver.executeScript("window.stop();"); } catch {}
    const current = (await driver.getCurrentUrl().catch(() => "")).toLowerCase();
    if (!current.includes(`/${username.toLowerCase()}`)) {
      return { ready: false, error: "Page load timed out before reaching the profile" };
    }
  }
  return waitForProfileReady(driver, timeoutMs);
}

module.exports = {
  jsFindAndClick,
  jsElementExists,
  waitForDialog,
  waitForProfileReady,
  openProfile,
  isSessionLost,
};
