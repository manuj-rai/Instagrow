const { sleep, randInt, normalizeUsername } = require("../utils");
const { state, log, logError, ensureDayCounter } = require("../state");
const {
  detectRateLimitWarning,
  clickUnfollowFlow,
  waitForProfileReady,
} = require("../selenium");
const { withDriverSession } = require("./runner");

async function runUnfollowJob({ usernames, config }) {
  ensureDayCounter();

  const cleaned = Array.from(new Set(usernames.map(normalizeUsername))).filter(Boolean);
  const remainingBudget = Math.max(0, config.dailyLimit - state.dailyCount);
  const queue = cleaned.slice(0, remainingBudget);

  if (queue.length === 0) {
    return { ok: false, message: "Daily limit reached or empty list" };
  }

  return withDriverSession({
    jobType: "unfollow",
    total: queue.length,
    jobName: `unfollow job (${queue.length} accounts, daily budget ${remainingBudget}/${config.dailyLimit})`,
    config,
    body: async (driver) => {
      for (let i = 0; i < queue.length; i++) {
        if (state.stopRequested) {
          log("⏹️  Stop requested. Ending run gracefully.");
          break;
        }
        const username = queue[i];
        state.lastUsername = username;
        log(`[${i + 1}/${queue.length}] Processing @${username}...`);

        try {
          await driver.get(`${config.baseUrl}/${username}/`);

          const profileStatus = await waitForProfileReady(driver, config.elementTimeoutMs);
          if (!profileStatus.ready) {
            state.failures += 1;
            logError(`Profile @${username} not ready`, new Error(profileStatus.error || "Timed out"));
            state.processed += 1;
            continue;
          }

          if (await detectRateLimitWarning(driver)) {
            logError("Rate-limit detected", new Error("Instagram is restricting actions"));
            state.stopRequested = true;
            break;
          }

          const result = await clickUnfollowFlow(driver, config.elementTimeoutMs, config.dryRun);

          if (result.ok) {
            state.successes += 1;
            if (!config.dryRun) state.dailyCount += 1;
            log(`✅ ${config.dryRun ? "[DRY RUN] " : ""}Unfollowed @${username}`);
          } else {
            state.failures += 1;
            logError(`Failed to unfollow @${username}`, new Error(result.error || "Unknown error"));
          }
        } catch (err) {
          state.failures += 1;
          logError(`Error processing @${username}`, err);
        } finally {
          state.processed += 1;
        }

        if (i < queue.length - 1 && !state.stopRequested) {
          const delay = randInt(config.minDelayMs, config.maxDelayMs);
          log(`⏳ Waiting ${Math.round(delay / 1000)}s before next action...`);
          await sleep(delay);
        }
      }

      log("✅ Job completed successfully");
      return {
        ok: true,
        queued: queue.length,
        processed: state.processed,
        successes: state.successes,
        failures: state.failures,
      };
    },
  });
}

module.exports = { runUnfollowJob };
