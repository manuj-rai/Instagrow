// Higher-level Instagram actions: login state, follow/unfollow flows,
// rate-limit detection, and "who am I logged in as?".

const { sleep } = require("../utils");
const { log } = require("../state");
const { jsFindAndClick, jsElementExists } = require("./dom");

async function checkLoginStatus(driver) {
  try {
    const url = await driver.getCurrentUrl();
    if (url.includes("/accounts/login/")) return false;
    const hasLoginForm = await driver.executeScript(function () {
      return !!(
        document.querySelector('[name="username"]') ||
        document.getElementById("loginForm")
      );
    });
    return !hasLoginForm;
  } catch {
    return false;
  }
}

async function detectRateLimitWarning(driver) {
  try {
    return await driver.executeScript(function () {
      var text = (document.body?.innerText || "").toLowerCase();
      var indicators = [
        "try again later",
        "we restrict certain activity",
        "we limit how often",
        "suspicious activity",
        "action blocked",
        "temporarily blocked",
        "too many requests",
      ];
      for (var i = 0; i < indicators.length; i++) {
        if (text.indexOf(indicators[i]) !== -1) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function clickUnfollowFlow(driver, elementTimeoutMs, dryRun) {
  try {
    const followingXpaths = [
      "//div[@role='button'][contains(., 'Following')]",
      "//span[normalize-space(text())='Following']/ancestor::div[@role='button'][1]",
      "//div[@aria-label='Following'][@role='button']",
      "//div[@role='button'][contains(., 'Requested')]",
      "//button[contains(., 'Following')]",
    ];

    if (dryRun) {
      const exists = await jsElementExists(driver, followingXpaths);
      if (!exists) {
        // Already not following — nothing to undo. skip (not a failure).
        return { ok: false, error: "Not following this user", skip: true, notFollowing: true };
      }
      log("DRY_RUN: Would click 'Following' button");
      return { ok: true, dryRun: true };
    }

    log("Looking for 'Following' button...");
    const clickResult = await jsFindAndClick(driver, followingXpaths, elementTimeoutMs);
    if (!clickResult.found) {
      // Already not following — nothing to undo. skip (not a failure).
      return { ok: false, error: "Not following this user", skip: true, notFollowing: true };
    }

    log("Clicked 'Following' button, waiting for dialog...");
    await sleep(600);

    const unfollowXpaths = [
      "//div[@role='dialog']//span[normalize-space(text())='Unfollow']/ancestor::div[@role='button'][1]",
      "//div[@role='dialog']//div[@role='button'][contains(., 'Unfollow')]",
      "//div[@role='dialog']//*[@role='button'][contains(., 'Unfollow')]",
      "//div[@role='dialog']//button[contains(., 'Unfollow')]",
      "//*[@role='dialog']//div[contains(@class, 'x1i10hfl')][contains(., 'Unfollow')]",
    ];

    log("Looking for 'Unfollow' confirmation...");
    const confirmResult = await jsFindAndClick(driver, unfollowXpaths, elementTimeoutMs);
    if (!confirmResult.found) {
      return { ok: false, error: "Unfollow confirmation button not found in dialog" };
    }

    log("Confirmed unfollow.");
    await sleep(400);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function clickFollowFlow(driver, elementTimeoutMs, dryRun) {
  try {
    const alreadyFollowingXpaths = [
      "//div[@role='button'][normalize-space()='Following']",
      "//div[@role='button'][normalize-space()='Requested']",
      "//button[normalize-space()='Following']",
      "//button[normalize-space()='Requested']",
    ];
    if (await jsElementExists(driver, alreadyFollowingXpaths)) {
      return { ok: false, error: "Already following or requested", skip: true };
    }

    const followXpaths = [
      "//div[@role='button'][normalize-space()='Follow']",
      "//div[@role='button'][normalize-space()='Follow Back']",
      "//button[normalize-space()='Follow']",
      "//button[normalize-space()='Follow Back']",
    ];

    if (dryRun) {
      const exists = await jsElementExists(driver, followXpaths);
      if (!exists) return { ok: false, error: "Follow button not found" };
      log("DRY_RUN: Would click 'Follow' button");
      return { ok: true, dryRun: true };
    }

    const result = await jsFindAndClick(driver, followXpaths, elementTimeoutMs);
    if (!result.found) return { ok: false, error: "Follow button not found" };

    await sleep(700);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Detect the currently logged-in IG username from page DOM signals.
 * Five-signal cascade — strongest first. Returns null if all fail.
 */
async function detectCurrentUser(driver) {
  try {
    return await driver.executeScript(function () {
      var SKIP = {
        explore: 1, reels: 1, reel: 1, direct: 1, accounts: 1, p: 1, tv: 1,
        stories: 1, inbox: 1, notifications: 1, "": 1, "?": 1,
      };

      function extractFromHref(href) {
        if (!href) return null;
        var m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
        if (!m) return null;
        var name = m[1].toLowerCase();
        return SKIP[name] ? null : name;
      }
      function climbToAnchorHref(el) {
        while (el && el !== document.body) {
          if (el.tagName === "A" && el.getAttribute("href")) {
            return el.getAttribute("href");
          }
          el = el.parentElement;
        }
        return null;
      }

      // Signal 1: avatar <img alt="<username>'s profile picture">
      var imgs = document.querySelectorAll("img[alt]");
      for (var i = 0; i < imgs.length; i++) {
        var alt = (imgs[i].getAttribute("alt") || "").toLowerCase();
        var match = alt.match(/^(.+?)['’]s profile (?:picture|photo)/);
        if (match && match[1] && /^[a-z0-9._]+$/.test(match[1].trim())) {
          return match[1].trim();
        }
        if (alt.indexOf("profile picture") !== -1 || alt.indexOf("profile photo") !== -1) {
          var u = extractFromHref(climbToAnchorHref(imgs[i]));
          if (u) return u;
        }
      }
      // Signal 2: <a aria-label="...Profile...">
      var labeled = document.querySelectorAll('a[aria-label*="rofile"]');
      for (var j = 0; j < labeled.length; j++) {
        var u2 = extractFromHref(labeled[j].getAttribute("href"));
        if (u2) return u2;
      }
      // Signal 3: <svg aria-label="Profile"> -> climb to <a>
      var svgs = document.querySelectorAll('svg[aria-label*="rofile"]');
      for (var k = 0; k < svgs.length; k++) {
        var u3 = extractFromHref(climbToAnchorHref(svgs[k]));
        if (u3) return u3;
      }
      // Signal 4: nav <a> with text === "Profile"
      var navs = document.querySelectorAll('nav a, [role="navigation"] a');
      for (var n = 0; n < navs.length; n++) {
        if ((navs[n].textContent || "").trim().toLowerCase() === "profile") {
          var u4 = extractFromHref(navs[n].getAttribute("href"));
          if (u4) return u4;
        }
      }
      // Signal 5: first plausible /username/ link in any nav
      for (var p = 0; p < navs.length; p++) {
        var u5 = extractFromHref(navs[p].getAttribute("href"));
        if (u5) return u5;
      }
      return null;
    });
  } catch {
    return null;
  }
}

module.exports = {
  checkLoginStatus,
  detectRateLimitWarning,
  clickUnfollowFlow,
  clickFollowFlow,
  detectCurrentUser,
};
