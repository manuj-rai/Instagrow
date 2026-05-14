require('dotenv').config();

const DEFAULTS = {
  port: 4545,
  minDelayMs: 15_000,
  maxDelayMs: 30_000,
  dailyLimit: 500,
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