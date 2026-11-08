// Thin Apify REST client (native fetch, Node 18+) for the
// `apify/instagram-followers-following-scraper` Actor.
//
// The Actor accepts one list type per run (`dataToScrape`: "followers" |
// "following"), so a full account scan is two runs. Tokens travel in the
// Authorization header — never in URLs — so they can't leak into logs.

const { normalizeUsername, sleep } = require("./utils");

const API = "https://api.apify.com/v2";
const ACTOR_ID = "apify~instagram-followers-following-scraper";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
// waitForFinish long-poll window. Short enough that a Stop click aborts the
// run (and its billing) within a few seconds.
const POLL_WAIT_SECS = 8;
const ITEMS_PAGE = 1000;

class ApifyError extends Error {
  constructor(message, { status, type } = {}) {
    super(message);
    this.name = "ApifyError";
    this.status = status;
    this.type = type;
  }
}

class StopRequested extends Error {
  constructor() {
    super("Stopped before the Apify run finished");
    this.name = "StopRequested";
  }
}

async function call(token, method, pathAndQuery, body) {
  const res = await fetch(API + pathAndQuery, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const e = json && json.error;
    throw new ApifyError(`Apify ${res.status}: ${(e && e.message) || text.slice(0, 200)}`, {
      status: res.status,
      type: e && e.type,
    });
  }
  return json;
}

// Starts a run with the first token that the API accepts. Auth / quota errors
// (401/402/403) fall through to the next token; anything else is fatal.
async function startRun(tokens, input, { maxChargeUsd } = {}) {
  if (!tokens.length) throw new ApifyError("No Apify token configured (APIFY_TOKENS in .env)");
  const qs = maxChargeUsd > 0 ? `?maxTotalChargeUsd=${encodeURIComponent(maxChargeUsd)}` : "";
  let lastErr;
  for (const token of tokens) {
    try {
      const { data } = await call(token, "POST", `/acts/${ACTOR_ID}/runs${qs}`, input);
      return { token, run: data };
    } catch (err) {
      lastErr = err;
      if (![401, 402, 403].includes(err.status)) throw err;
    }
  }
  throw lastErr;
}

async function abortRun(token, runId) {
  try { await call(token, "POST", `/actor-runs/${runId}/abort`); } catch {}
}

async function datasetItemCount(token, datasetId) {
  try {
    const { data } = await call(token, "GET", `/datasets/${datasetId}`);
    return data.itemCount || 0;
  } catch {
    return null;
  }
}

async function fetchAllItems(token, datasetId) {
  const items = [];
  for (let offset = 0; ; offset += ITEMS_PAGE) {
    const page = await call(
      token,
      "GET",
      `/datasets/${datasetId}/items?clean=true&format=json&offset=${offset}&limit=${ITEMS_PAGE}`
    );
    if (!Array.isArray(page)) break;
    items.push(...page);
    if (page.length < ITEMS_PAGE) break;
  }
  return items;
}

/**
 * Runs the Actor for one profile + list type and returns the usernames.
 *
 * @param {string[]} tokens
 * @param {{ username: string, type: "followers"|"following", resultsLimit?: number,
 *           maxChargeUsd?: number, shouldStop?: () => boolean,
 *           onProgress?: (count: number) => void }} opts
 * @returns {Promise<{ usernames: string[], runId: string, usageUsd: number|null }>}
 */
async function scrapeList(tokens, { username, type, resultsLimit, maxChargeUsd, shouldStop, onProgress }) {
  const input = { usernames: [normalizeUsername(username)], dataToScrape: type };
  if (resultsLimit > 0) input.resultsLimit = resultsLimit;

  const { token, run: started } = await startRun(tokens, input, { maxChargeUsd });
  let run = started;

  while (!TERMINAL.has(run.status)) {
    if (shouldStop && shouldStop()) {
      await abortRun(token, run.id);
      throw new StopRequested();
    }
    try {
      ({ data: run } = await call(token, "GET", `/actor-runs/${run.id}?waitForFinish=${POLL_WAIT_SECS}`));
    } catch (err) {
      // Transient network blip while polling — the run keeps going server-side.
      if (err.status && err.status < 500) throw err;
      await sleep(3000);
      continue;
    }
    if (onProgress && !TERMINAL.has(run.status)) {
      const n = await datasetItemCount(token, run.defaultDatasetId);
      if (n !== null) onProgress(n);
    }
  }

  if (run.status !== "SUCCEEDED") {
    throw new ApifyError(`Apify ${type} run ${run.id} ended with status ${run.status}`);
  }

  const items = await fetchAllItems(token, run.defaultDatasetId);
  // A private / missing profile yields a single { error, errorDescription } item.
  const errorItem = items.find((it) => it && it.error);
  const userItems = items.filter((it) => it && !it.error && it.username);
  if (userItems.length === 0 && errorItem) {
    throw new ApifyError(`Apify could not scrape @${username} ${type}: ${errorItem.errorDescription || errorItem.error}`);
  }

  const self = normalizeUsername(username);
  const usernames = Array.from(new Set(userItems.map((it) => normalizeUsername(it.username))))
    .filter((u) => u && u !== self);

  return {
    usernames,
    runId: run.id,
    usageUsd: typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : null,
  };
}

// Plan lookup, used only to warn about the free plan's first-page limit.
async function getPlan(tokens) {
  for (const token of tokens) {
    try {
      const { data } = await call(token, "GET", "/users/me");
      return data && data.plan ? data.plan.id : null;
    } catch {}
  }
  return null;
}

module.exports = { scrapeList, getPlan, ApifyError, StopRequested };
