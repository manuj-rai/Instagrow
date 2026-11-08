const { normalizeUsername } = require("../utils");
const { state, log } = require("../state");
const { detectCurrentUser, scrapeUsernamesFromSource } = require("../selenium");
const { saveSnapshot } = require("../persistence");
const { withDriverSession } = require("./runner");

async function runScanJob({ ownerUsername, config }) {
  return withDriverSession({
    jobType: "scan",
    total: 2, // followers, then following
    jobName: "account scan",
    config,
    body: async (driver) => {
      let me = ownerUsername ? normalizeUsername(ownerUsername) : null;
      if (!me) {
        me = await detectCurrentUser(driver);
        if (!me) {
          throw new Error(
            "Could not auto-detect your Instagram username. Enter it in the UI and retry."
          );
        }
        log(`✓ Detected logged-in user: @${me}`);
      } else {
        log(`Using provided username: @${me}`);
      }
      state.lastUsername = me;

      log(`Scraping @${me}'s followers list...`);
      const followers = await scrapeUsernamesFromSource(driver, {
        sourceUsername: me,
        sourceType: "followers",
        harvestAll: true,
        baseUrl: config.baseUrl,
        elementTimeoutMs: config.elementTimeoutMs,
      });
      state.processed = 1;
      state.successes = 1;
      log(`✓ Followers: ${followers.length}`);

      if (state.stopRequested) {
        log("⏹️  Stop requested after followers scrape. Saving partial snapshot.");
        saveSnapshot({ owner: me, scannedAt: new Date().toISOString(), source: "live_scan_partial", followers, following: [] });
        return { ok: true, partial: true, owner: me, followers: followers.length };
      }

      log(`Scraping @${me}'s following list...`);
      const following = await scrapeUsernamesFromSource(driver, {
        sourceUsername: me,
        sourceType: "following",
        harvestAll: true,
        baseUrl: config.baseUrl,
        elementTimeoutMs: config.elementTimeoutMs,
      });
      state.processed = 2;
      state.successes = 2;
      log(`✓ Following: ${following.length}`);

      saveSnapshot({
        owner: me,
        scannedAt: new Date().toISOString(),
        source: "live_scan",
        followers,
        following,
      });
      log(`💾 Snapshot saved to data/snapshot.json`);

      return {
        ok: true,
        owner: me,
        followers: followers.length,
        following: following.length,
      };
    },
  });
}

module.exports = { runScanJob };
