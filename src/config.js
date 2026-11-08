require('dotenv').config();

const DEFAULTS = {
  port: 4545,
  minDelayMs: 15_000,
  maxDelayMs: 30_000,
  dailyLimit: 80, // conservative default; see readme "Safe pacing"
  baseUrl: "https://www.instagram.com",
  pageLoadTimeoutMs: 45_000,
  elementTimeoutMs: 12_000,
  nodeEnv: 'development',
  corsOrigin: '*',
  useRemoteDebugging: false,       // NEW
  remoteDebuggingPort: 9222,       // NEW
};

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Like toInt but allows fractions (e.g. 0.5 hours, $2.50). Non-positive → fallback.
function toPosNum(value, fallback) {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toList(value) {
  return String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const v = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

function getConfig() {
  const config = {
    nodeEnv: process.env.NODE_ENV || DEFAULTS.nodeEnv,
    port: toInt(process.env.PORT, DEFAULTS.port),
    chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || "",
    chromeProfileDir: process.env.CHROME_PROFILE_DIR || "",
    minDelayMs: toInt(process.env.MIN_DELAY_MS, DEFAULTS.minDelayMs),
    maxDelayMs: toInt(process.env.MAX_DELAY_MS, DEFAULTS.maxDelayMs),
    dailyLimit: toInt(process.env.DAILY_LIMIT, DEFAULTS.dailyLimit),
    baseUrl: process.env.IG_BASE_URL || DEFAULTS.baseUrl,
    pageLoadTimeoutMs: toInt(process.env.PAGE_LOAD_TIMEOUT_MS, DEFAULTS.pageLoadTimeoutMs),
    elementTimeoutMs: toInt(process.env.ELEMENT_TIMEOUT_MS, DEFAULTS.elementTimeoutMs),
    dryRun: toBool(process.env.DRY_RUN, false),
    corsOrigin: process.env.CORS_ORIGIN || DEFAULTS.corsOrigin,
    logLevel: process.env.LOG_LEVEL || 'info',
    useRemoteDebugging: toBool(process.env.USE_REMOTE_DEBUGGING, DEFAULTS.useRemoteDebugging),   // NEW
    remoteDebuggingPort: toInt(process.env.REMOTE_DEBUGGING_PORT, DEFAULTS.remoteDebuggingPort), // NEW
    importDir: process.env.IG_IMPORT_DIR || "",
    importOwner: process.env.IG_IMPORT_OWNER || "",
    importPollMs: toInt(process.env.IG_IMPORT_POLL_MS, 30_000),
    // Apify (apify/instagram-followers-following-scraper). Comma-separated
    // tokens are tried in order; a token rejected for auth/quota falls through.
    apifyTokens: toList(process.env.APIFY_TOKENS || process.env.APIFY_TOKEN),
    apifyScanIntervalHours: toPosNum(process.env.APIFY_SCAN_INTERVAL_HOURS, 0), // 0 = no auto-scan
    apifyResultsLimit: toInt(process.env.APIFY_RESULTS_LIMIT, 10_000),          // per list, per run
    apifyMaxChargeUsd: toPosNum(process.env.APIFY_MAX_CHARGE_USD, 0),           // per run; 0 = no cap
  };
  config.apifyGuard = {
    maxShrinkPct: Math.min(100, toInt(process.env.APIFY_MAX_SHRINK_PCT, 25)),
    resultsLimit: config.apifyResultsLimit,
  };

  if (!config.chromeUserDataDir && config.nodeEnv === 'production') {
    console.warn('⚠️  CHROME_USER_DATA_DIR not set in production');
  }

  if (config.minDelayMs >= config.maxDelayMs) {
    console.warn('⚠️  MIN_DELAY_MS should be less than MAX_DELAY_MS');
  }

  return config;
}

module.exports = { getConfig, DEFAULTS };