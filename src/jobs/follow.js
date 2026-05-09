const { sleep, randInt, shuffleAndPick } = require("../utils");
const { state, log, logError, ensureDayCounter } = require("../state");
const {
  detectRateLimitWarning,
  clickFollowFlow,
  scrapeUsernamesFromSource,
  waitForProfileReady,
} = require("../selenium");
const { withDriverSession } = require("./runner");

async function runFollowJob({ source, count, config }) {
  ensureDayCounter();

  const remainingBudget = Math.max(0, config.dailyLimit - state.dailyCount);
  const desired = Math.min(count, remainingBudget);
  if (desired === 0) return { ok: false, message: "Daily limit reached" };

  return withDriverSession({
    jobType: "follow",
    total: desired,
    jobName: `follow job (target ${desired}, daily budget ${remainingBudget}/${config.dailyLimit})`,
    config,
    body: async (driver) => {
      const candidates = await scrapeUsernamesFromSource(driver, {
        sourceUsername: source.username,
        sourceType: source.type,
        targetCount: desired,
        baseUrl: config.baseUrl,
        elementTimeoutMs: config.elementTimeoutMs,
      });

      if (state.stopRequested) {
        log("⏹️  Stop requested before follow loop.");
        return { ok: true, processed: 0 };
      }
      if (candidates.length === 0) {
        throw new Error("No candidate usernames found");
      }

      // Oversample so action-time skips (already-following) don't starve us.
      const queue = shuffleAndPick(candidates, Math.min(candidates.length, desired * 2));
      state.total = desired;

      log(`🎯 Following up to ${desired} of ${queue.length} shuffled candidates...`);

      let followed = 0;
      for (let i = 0; i < queue.length && followed < desired; i++) {
        if (state.stopRequested) {
          log("⏹️  Stop requested. Ending run gracefully.");
          break;
        }
        const username = queue[i];
        state.lastUsername = username;
        log(`[${followed + 1}/${desired}] Visiting @${username}...`);

        try {
          await driver.get(`${config.baseUrl}/${username}/`);

          const profileStatus = await waitForProfileReady(driver, config.elementTimeoutMs);
          if (!profileStatus.ready) {
            state.failures += 1;
            logError(`Profile @${username} not ready`, new Error(profileStatus.error || "timeout"));
            state.processed += 1;
            continue;
          }

          if (await detectRateLimitWarning(driver)) {
            logError("Rate-limit detected", new Error("Instagram is restricting actions"));
            state.stopRequested = true;
            break;
          }

          const result = await clickFollowFlow(driver, config.elementTimeoutMs, config.dryRun);

          if (result.ok) {
            state.successes += 1;
            followed += 1;
            if (!config.dryRun) state.dailyCount += 1;
            log(`✅ ${config.dryRun ? "[DRY RUN] " : ""}Followed @${username}`);
          } else if (result.skip) {
            log(`↷  Skipped @${username} (${result.error})`);
          } else {
            state.failures += 1;
            logError(`Failed to follow @${username}`, new Error(result.error || "unknown"));
          }
        } catch (err) {
          state.failures += 1;
          logError(`Error processing @${username}`, err);
        } finally {
          state.processed += 1;
        }

        if (followed < desired && i < queue.length - 1 && !state.stopRequested) {
          const delay = randInt(config.minDelayMs, config.maxDelayMs);
          log(`⏳ Waiting ${Math.round(delay / 1000)}s before next action...`);
          await sleep(delay);
        }
      }

      log("✅ Follow job completed");
      return {
        ok: true,
        target: desired,
        processed: state.processed,
        successes: state.successes,
        failures: state.failures,
      };
    },
  });
}

module.exports = { runFollowJob };
