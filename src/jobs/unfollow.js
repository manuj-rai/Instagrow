const { sleep, randInt, normalizeUsername } = require("../utils");
const { state, log, logError, ensureDayCounter } = require("../state");
const {
  detectRateLimitWarning,
  clickUnfollowFlow,
  openProfile,
  isSessionLost,
} = require("../selenium");

// Chrome restarts / crashes are survivable a few times per run; past that the
// run stops instead of failing every remaining account in a tight loop.
const MAX_RECONNECTS = 3;
const { recordUnfollow, unfollowedSet } = require("../history");
const { withDriverSession } = require("./runner");

async function runUnfollowJob({ usernames, config }) {
  ensureDayCounter();

  const cleaned = Array.from(new Set(usernames.map(normalizeUsername))).filter(Boolean);

  // Drop anyone we've already unfollowed in a previous run — never act twice.
  const alreadyUnfollowed = unfollowedSet();
  const fresh = cleaned.filter((u) => !alreadyUnfollowed.has(u));
  const skippedAlready = cleaned.length - fresh.length;
  if (skippedAlready > 0) {
    log(`↷  Skipping ${skippedAlready} account(s) already unfollowed in a previous run.`);
  }

  const remainingBudget = Math.max(0, config.dailyLimit - state.dailyCount);
  const queue = fresh.slice(0, remainingBudget);

  if (queue.length === 0) {
    return {
      ok: false,
      message: skippedAlready > 0
        ? "All requested accounts were already unfollowed previously"
        : "Daily limit reached or empty list",
    };
  }

  return withDriverSession({
    jobType: "unfollow",
    total: queue.length,
    jobName: `unfollow job (${queue.length} accounts, daily budget ${remainingBudget}/${config.dailyLimit})`,
    config,
    body: async (driver, { reconnect }) => {
      let reconnects = 0;
      for (let i = 0; i < queue.length; i++) {
        if (state.stopRequested) {
          log("⏹️  Stop requested. Ending run gracefully.");
          break;
        }
        const username = queue[i];
        state.lastUsername = username;
        log(`[${i + 1}/${queue.length}] Processing @${username}...`);
        let retrySame = false;

        try {
          const profileStatus = await openProfile(driver, config.baseUrl, username, config.elementTimeoutMs);
          if (!profileStatus.ready) {
            state.failures += 1;
            logError(`Profile @${username} not ready`, new Error(profileStatus.error || "Timed out"));
            continue; // finally{} counts it as processed
          }

          if (await detectRateLimitWarning(driver)) {
            logError("Rate-limit detected", new Error("Instagram is restricting actions"));
            state.stopRequested = true;
            break;
          }

          const result = await clickUnfollowFlow(driver, config.elementTimeoutMs, config.dryRun);

          if (result.ok) {
            state.successes += 1;
            if (!config.dryRun) {
              state.dailyCount += 1;
              recordUnfollow(username); // remember so we never revisit this account
            }
            log(`✅ ${config.dryRun ? "[DRY RUN] " : ""}Unfollowed @${username}`);
          } else if (result.skip) {
            // Already not following them — nothing to undo. Record it so the
            // account drops out of future unfollow lists, and don't count a failure.
            if (!config.dryRun) recordUnfollow(username);
            log(`↷  Skipped @${username} (${result.error})`);
          } else {
            state.failures += 1;
            logError(`Failed to unfollow @${username}`, new Error(result.error || "Unknown error"));
          }
        } catch (err) {
          if (isSessionLost(err)) {
            if (reconnects >= MAX_RECONNECTS) {
              logError(`Chrome connection lost ${reconnects + 1} times — stopping run (remaining accounts untouched)`, err);
              break;
            }
            reconnects += 1;
            try {
              driver = await reconnect();
              retrySame = true; // nothing happened to this account yet — redo it
              i -= 1;
              continue;
            } catch (reErr) {
              logError("Could not reconnect to Chrome — stopping run (remaining accounts untouched)", reErr);
              break;
            }
          }
          state.failures += 1;
          logError(`Error processing @${username}`, err);
        } finally {
          if (!retrySame) state.processed += 1;
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
