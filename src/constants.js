// Centralized magic values. One place to update if Instagram changes them.

// Source types supported by the scraper.
const SCRAPE_TYPES = new Set(["followers", "following"]);

// Modal-open / scroll timings.
const DIRECT_URL_DIALOG_WAIT_MS = 4000;
const POST_DIALOG_WAIT_MS = 1500;
const SCROLL_STEP_PX = 800;
const SCROLL_LOOP_DELAY_MS = 900;
const STABLE_AT_BOTTOM_LIMIT = 20;

// Login wait when not signed in.
const LOGIN_WAIT_MS = 60_000;

module.exports = {
  SCRAPE_TYPES,
  DIRECT_URL_DIALOG_WAIT_MS,
  POST_DIALOG_WAIT_MS,
  SCROLL_STEP_PX,
  SCROLL_LOOP_DELAY_MS,
  STABLE_AT_BOTTOM_LIMIT,
  LOGIN_WAIT_MS,
};
