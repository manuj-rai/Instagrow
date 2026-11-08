// Account scan via Apify — no browser, no Selenium, no load on the IG session.
// Fetches the owner's followers + following with the Apify Actor (two runs in
// parallel) and writes data/snapshot.json exactly like the other scan paths.
//
// Safety: the snapshot drives the "not following back" list, so a truncated
// result (free Apify plan = first page only, results cap hit, throttled run)
// would flag mutuals for unfollow. A result that shrinks either list by more
// than APIFY_MAX_SHRINK_PCT vs the previous snapshot is parked as `pending` in
// data/apify-state.json instead; acceptPendingApifyResult() promotes it on
// explicit user confirmation, without paying for another run.

const fs = require("fs");
const path = require("path");
const { normalizeUsername } = require("../utils");
const { state, log, logError, resetRun, endRun } = require("../state");
const { saveSnapshot, loadSnapshot, DATA_DIR } = require("../persistence");
const { unfollowedSet } = require("../history");
const { scrapeList, getPlan, StopRequested } = require("../apify");

const STATE_PATH = path.join(DATA_DIR, "apify-state.json");
const SCHEDULER_TICK_MS = 60_000;
// Below this many entries a shrink comparison is too noisy to be meaningful.
const MIN_LIST_FOR_GUARD = 50;

/* ---------------- Persistent state ---------------- */

function loadApifyState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function updateApifyState(patch) {
  const next = { ...loadApifyState(), ...patch };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATE_PATH);
  return next;
}

/* ---------------- Helpers ---------------- */

// Explicit input → IG_IMPORT_OWNER → owner of the last snapshot.
function resolveApifyOwner(ownerUsername, config) {
  const snap = ownerUsername || config.importOwner ? null : loadSnapshot();
  return normalizeUsername(ownerUsername || config.importOwner || (snap && snap.owner) || "");
}

const n = (x) => Number(x).toLocaleString();

// Returns a human-readable reason when `next` looks truncated, else null.
function incompleteReason(next, { maxShrinkPct, resultsLimit }) {
  const reasons = [];

  if (next.followers.length === 0 && next.following.length === 0) {
    reasons.push("both lists came back empty");
  }
  if (resultsLimit > 0) {
    for (const type of ["followers", "following"]) {
      if (next[type].length >= resultsLimit) {
        reasons.push(`${type} hit the APIFY_RESULTS_LIMIT cap (${n(resultsLimit)})`);
      }
    }
  }

  const prev = loadSnapshot();
  if (prev && normalizeUsername(prev.owner) === next.owner) {
    // Compare against what we *expect* following to be: the last snapshot
    // minus accounts this app has unfollowed since.
    const unfollowed = unfollowedSet();
    const expected = {
      followers: (prev.followers || []).length,
      following: (prev.following || []).filter((u) => !unfollowed.has(u)).length,
    };
    const keep = 1 - maxShrinkPct / 100;
    for (const type of ["followers", "following"]) {
      const before = expected[type];
      if (before >= MIN_LIST_FOR_GUARD && next[type].length < Math.floor(before * keep)) {
        reasons.push(`${type}: ${n(next[type].length)} vs ${n(before)} in the last snapshot`);
      }
    }
  }

  return reasons.length ? reasons.join("; ") : null;
}

function commitSnapshot(result, scannedAt) {
  saveSnapshot({
    owner: result.owner,
    scannedAt,
    source: "apify",
    apifyRunIds: result.runIds,
    followers: result.followers,
    following: result.following,
  });
  state.lastUsername = result.owner;
}

/* ---------------- Job ---------------- */

async function runApifyScanJob({ ownerUsername, config, trigger = "manual" }) {
  // Everything up to resetRun() is synchronous, so two near-simultaneous
  // starts can't both pass the running check.
  if (state.running) return { ok: false, message: "A job is already running" };
  const owner = resolveApifyOwner(ownerUsername, config);
  if (!owner) {
    return { ok: false, message: "No Instagram username — enter it in the UI or set IG_IMPORT_OWNER in .env" };
  }

  resetRun(2, "apify-scan");
  state.lastUsername = owner;
  updateApifyState({ lastAttemptAt: new Date().toISOString(), lastTrigger: trigger });
  log(`☁️  Apify scan (${trigger}) for @${owner}: fetching followers + following...`);

  const counts = { followers: 0, following: 0 };
  let siblingFailed = false; // first failure aborts the other run so it stops billing
  const shouldStop = () => state.stopRequested || siblingFailed;

  const fetchList = (type) =>
    scrapeList(config.apifyTokens, {
      username: owner,
      type,
      resultsLimit: config.apifyResultsLimit,
      maxChargeUsd: config.apifyMaxChargeUsd,
      shouldStop,
      onProgress: (count) => {
        counts[type] = count;
        state.lastMessage = `Apify: ${n(counts.followers)} followers · ${n(counts.following)} following so far...`;
      },
    }).then(
      (r) => {
        state.processed += 1;
        state.successes += 1;
        log(`✓ Apify ${type}: ${n(r.usernames.length)}`);
        return r;
      },
      (err) => {
        siblingFailed = true;
        throw err;
      }
    );

  try {
    if ((await getPlan(config.apifyTokens)) === "FREE") {
      log(
        "⚠️  Apify account is on the FREE plan — the Actor only returns the first page of each list there, " +
        "so this result will likely be held back as incomplete.",
        "warn"
      );
    }

    // allSettled (not all) so a failed run's sibling finishes aborting before we return.
    const settled = await Promise.allSettled([fetchList("followers"), fetchList("following")]);
    const failures = settled.filter((s) => s.status === "rejected").map((s) => s.reason);
    if (failures.length) {
      // Prefer the real error over the StopRequested it triggered in the sibling.
      throw failures.find((e) => !(e instanceof StopRequested)) || failures[0];
    }

    const [fr, fg] = settled.map((s) => s.value);
    const usages = [fr.usageUsd, fg.usageUsd].filter((u) => typeof u === "number");
    const usageUsd = usages.length ? usages.reduce((a, b) => a + b, 0) : null;
    const costNote = usageUsd !== null ? ` (Apify usage $${usageUsd.toFixed(2)})` : "";
    const result = { owner, followers: fr.usernames, following: fg.usernames, runIds: [fr.runId, fg.runId] };
    const now = new Date().toISOString();

    const reason = incompleteReason(result, config.apifyGuard);
    if (reason) {
      updateApifyState({
        pending: { ...result, scrapedAt: now },
        lastUsageUsd: usageUsd,
        lastError: { code: "INCOMPLETE", message: `Result looks incomplete — ${reason}. Snapshot not overwritten.`, at: now },
      });
      log(
        `🛑 Apify result looks incomplete (${reason}) — snapshot NOT overwritten${costNote}. ` +
        `If it is genuinely correct, click "Save anyway" in the UI.`,
        "warn"
      );
      return { ok: false, held: true, reason };
    }

    commitSnapshot(result, now);
    updateApifyState({
      pending: null,
      lastSuccessAt: now,
      lastCounts: { followers: result.followers.length, following: result.following.length },
      lastUsageUsd: usageUsd,
      lastError: null,
    });
    log(`💾 Snapshot saved from Apify: ${n(result.followers.length)} followers, ${n(result.following.length)} following${costNote}`);
    return { ok: true, owner, followers: result.followers.length, following: result.following.length };
  } catch (err) {
    const at = new Date().toISOString();
    if (err instanceof StopRequested) {
      log("⏹️  Apify scan stopped — runs aborted, snapshot unchanged.");
      updateApifyState({ lastError: { code: "STOPPED", message: "Stopped by user", at } });
      return { ok: false, stopped: true };
    }
    logError("Apify scan failed", err);
    updateApifyState({ lastError: { code: "FAILED", message: err.message, at } });
    return { ok: false, error: err.message };
  } finally {
    endRun(`Apify scan finished for @${owner}.`);
  }
}

// Promotes a held-back result to the snapshot (user confirmed it's correct).
function acceptPendingApifyResult() {
  if (state.running) return { ok: false, message: "Stop the running job first" };
  const { pending } = loadApifyState();
  if (!pending) return { ok: false, message: "No held-back Apify result to save" };

  commitSnapshot(pending, pending.scrapedAt || new Date().toISOString());
  const lastCounts = { followers: pending.followers.length, following: pending.following.length };
  updateApifyState({ pending: null, lastSuccessAt: new Date().toISOString(), lastCounts, lastError: null });
  log(`💾 Saved held-back Apify result for @${pending.owner}: ${n(lastCounts.followers)} followers, ${n(lastCounts.following)} following`);
  return { ok: true, counts: lastCounts };
}

/* ---------------- Scheduler + status ---------------- */

function schedulerEnabled(config) {
  return config.apifyTokens.length > 0 && config.apifyScanIntervalHours > 0;
}

function nextRunAtMs(config) {
  if (!schedulerEnabled(config)) return null;
  const last = loadApifyState().lastAttemptAt;
  // Never run before → due on the first scheduler tick (~1 min after boot).
  return last ? new Date(last).getTime() + config.apifyScanIntervalHours * 3_600_000 : Date.now();
}

let schedulerTimer = null;

function startApifyScheduler(config) {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  if (!config.apifyTokens.length) {
    log("☁️  Apify disabled (APIFY_TOKENS not set).");
    return;
  }
  if (!schedulerEnabled(config)) {
    log("☁️  Apify ready (manual). Set APIFY_SCAN_INTERVAL_HOURS to auto-scan on a schedule.");
    return;
  }
  if (!resolveApifyOwner(null, config)) {
    log("⚠️  Apify auto-scan disabled — no owner. Set IG_IMPORT_OWNER in .env or run one scan first.", "warn");
    return;
  }

  log(
    `☁️  Apify auto-scan every ${config.apifyScanIntervalHours}h ` +
    `(next due ${new Date(nextRunAtMs(config)).toLocaleString()})`
  );
  schedulerTimer = setInterval(() => {
    const due = nextRunAtMs(config);
    // A busy app (unfollow/follow job) just defers the scan to a later tick.
    if (due === null || Date.now() < due || state.running) return;
    runApifyScanJob({ config, trigger: "scheduled" })
      .then((r) => { if (r && r.message) log(`Apify auto-scan skipped: ${r.message}`, "warn"); })
      .catch((err) => logError("Apify auto-scan error", err));
  }, SCHEDULER_TICK_MS);
}

function getApifyStatus(config) {
  const s = loadApifyState();
  const next = nextRunAtMs(config);
  return {
    enabled: config.apifyTokens.length > 0,
    intervalHours: config.apifyScanIntervalHours,
    nextRunAt: next ? new Date(next).toISOString() : null,
    lastAttemptAt: s.lastAttemptAt || null,
    lastSuccessAt: s.lastSuccessAt || null,
    lastCounts: s.lastCounts || null,
    lastUsageUsd: typeof s.lastUsageUsd === "number" ? s.lastUsageUsd : null,
    lastError: s.lastError || null,
    pending: s.pending
      ? { followers: s.pending.followers.length, following: s.pending.following.length, scrapedAt: s.pending.scrapedAt }
      : null,
  };
}

module.exports = {
  runApifyScanJob,
  acceptPendingApifyResult,
  startApifyScheduler,
  getApifyStatus,
  resolveApifyOwner,
};
