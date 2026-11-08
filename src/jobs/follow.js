const { sleep, randInt, shuffleAndPick } = require("../utils");
const { state, log, logError, ensureDayCounter } = require("../state");
const {
  detectRateLimitWarning,
  clickFollowFlow,
  scrapeUsernamesFromSource,
  openProfile,
  isSessionLost,
} = require("../selenium");

// See unfollow.js — survive a few Chrome restarts, then stop instead of spinning.
const MAX_RECONNECTS = 3;
const { recordFollow, followedSet, unfollowedSet } = require("../history");
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
    body: async (driver, { reconnect }) => {
      let reconnects = 0;
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

      // Drop anyone we've already acted on: never follow the same account twice,
      // and don't re-follow someone we deliberately unfollowed (avoids churn).
      const alreadyFollowed = followedSet();
      const alreadyUnfollowed = unfollowedSet();
      const candidateList = candidates.filter(
        (u) => !alreadyFollowed.has(u) && !alreadyUnfollowed.has(u)
      );
      const skippedFollowed = candidates.filter((u) => alreadyFollowed.has(u)).length;
      const skippedUnfollowed = candidates.filter((u) => alreadyUnfollowed.has(u)).length;
      if (skippedFollowed || skippedUnfollowed) {
        log(
          `↷  Filtered ${skippedFollowed} already-followed + ${skippedUnfollowed} previously-unfollowed; ` +
          `${candidateList.length} fresh candidate(s) remain.`
        );
      }
      if (candidateList.length === 0) {
        throw new Error("No fresh candidates — every scraped account was already followed or unfollowed before.");
      }

      // Oversample so action-time skips (already-following) don't starve us.
      const queue = shuffleAndPick(candidateList, Math.min(candidateList.length, desired * 2));
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
        let retrySame = false;

        try {
          const profileStatus = await openProfile(driver, config.baseUrl, username, config.elementTimeoutMs);
          if (!profileStatus.ready) {
            state.failures += 1;
            logError(`Profile @${username} not ready`, new Error(profileStatus.error || "timeout"));
            continue; // finally{} counts it as processed
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
            if (!config.dryRun) {
              state.dailyCount += 1;
              recordFollow(username); // remember so we never follow this account again
            }
            log(`✅ ${config.dryRun ? "[DRY RUN] " : ""}Followed @${username}`);
          } else if (result.skip) {
            // IG already shows Following/Requested — remember it so we don't revisit.
            if (!config.dryRun) recordFollow(username);
            log(`↷  Skipped @${username} (${result.error})`);
          } else {
            state.failures += 1;
            logError(`Failed to follow @${username}`, new Error(result.error || "unknown"));
          }
        } catch (err) {
          if (isSessionLost(err)) {
            if (reconnects >= MAX_RECONNECTS) {
              logError(`Chrome connection lost ${reconnects + 1} times — stopping run`, err);
              break;
            }
            reconnects += 1;
            try {
              driver = await reconnect();
              retrySame = true; // nothing happened to this account yet — redo it
              i -= 1;
              continue;
            } catch (reErr) {
              logError("Could not reconnect to Chrome — stopping run", reErr);
              break;
            }
          }
          state.failures += 1;
          logError(`Error processing @${username}`, err);
        } finally {
          if (!retrySame) state.processed += 1;
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
