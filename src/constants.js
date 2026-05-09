// Centralized magic values. One place to update if Instagram changes them.

// Public web-app ID Instagram uses for its own /api/v1/* requests.
const IG_APP_ID = "936619743392459";

// Source types supported by the scraper.
const SCRAPE_TYPES = new Set(["followers", "following"]);

// Modal-open / scroll timings.
const DIRECT_URL_DIALOG_WAIT_MS = 4000;
const POST_DIALOG_WAIT_MS = 600;
const SCROLL_STEP_PX = 800;
const SCROLL_LOOP_DELAY_MS = 900;
const STABLE_AT_BOTTOM_LIMIT = 8;
const SCRAPE_API_PAGE_SIZE = 100;
const SCRAPE_API_PAGE_DELAY_MS = 700;

// Login wait when not signed in.
const LOGIN_WAIT_MS = 60_000;

module.exports = {
  IG_APP_ID,
  SCRAPE_TYPES,
  DIRECT_URL_DIALOG_WAIT_MS,
  POST_DIALOG_WAIT_MS,
  SCROLL_STEP_PX,
  SCROLL_LOOP_DELAY_MS,
  STABLE_AT_BOTTOM_LIMIT,
  SCRAPE_API_PAGE_SIZE,
  SCRAPE_API_PAGE_DELAY_MS,
  LOGIN_WAIT_MS,
};
