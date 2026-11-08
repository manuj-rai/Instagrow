const fs = require("fs");
const path = require("path");

const MAX_LOG_ENTRIES = 5000;
const LOG_DIR = path.join(__dirname, "..", "data", "logs");
let fileStream = null;
let fileStreamDayKey = null;

function ensureLogFile() {
  const d = new Date();
  const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (dayKey === fileStreamDayKey && fileStream) return fileStream;
  try {
    if (fileStream) try { fileStream.end(); } catch {}
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fileStream = fs.createWriteStream(path.join(LOG_DIR, `${dayKey}.log`), { flags: "a" });
    fileStreamDayKey = dayKey;
  } catch (err) {
    // File logging is best-effort — never crash the app if disk is full / read-only.
    fileStream = null;
  }
  return fileStream;
}

const state = {
  running: false,
  stopRequested: false,
  jobType: null, // 'follow' | 'unfollow' | 'scan' | null
  startedAt: null,
  finishedAt: null,
  total: 0,
  processed: 0,
  successes: 0,
  failures: 0,
  lastMessage: "",
  lastUsername: "",
  lastError: null,
  logs: [],          // bounded ring (newest first); see MAX_LOG_ENTRIES
  // daily counter (in-memory, resets on server restart)
  dayKey: null,
  dailyCount: 0,
};

function nowDayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Actions already recorded today in data/history.json. Seeds the daily counter
// so a backend restart can't reset the daily safety limit to 0. Slightly
// conservative: accounts skipped as "already (un)followed" are recorded too.
function actionsRecordedOn(dayKey) {
  try {
    const { loadHistory } = require("./history");
    const h = loadHistory();
    let n = 0;
    for (const kind of ["followed", "unfollowed"]) {
      for (const at of Object.values(h[kind])) {
        const d = new Date(at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (key === dayKey) n += 1;
      }
    }
    return n;
  } catch {
    return 0;
  }
}

function ensureDayCounter() {
  const key = nowDayKey();
  if (state.dayKey !== key) {
    const firstCheck = state.dayKey === null;
    state.dayKey = key;
    state.dailyCount = firstCheck ? actionsRecordedOn(key) : 0;
    log(firstCheck && state.dailyCount
      ? `Day counter for ${key} restored from history: ${state.dailyCount} action(s) already today`
      : `Day counter reset for ${key}`);
  }
}

function log(line, level = 'info') {
  const timestamp = new Date().toISOString();
  state.lastMessage = line;
  state.logs.unshift({ timestamp, message: line, level });
  if (state.logs.length > MAX_LOG_ENTRIES) {
    state.logs.length = MAX_LOG_ENTRIES;
  }

  // Single line per event: written once to the daily log file and once to
  // stdout (so terminal + tail -f see the same thing).
  const formatted = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${line}`;
  const stream = ensureLogFile();
  if (stream) {
    try { stream.write(formatted + "\n"); } catch {}
  }
  if (level === 'error') console.error(formatted);
  else if (level === 'warn') console.warn(formatted);
  else console.log(formatted);
}

function logError(line, error) {
  const errorMsg = error?.message || String(error);
  state.lastError = { message: line, error: errorMsg, timestamp: new Date().toISOString() };
  log(`${line}: ${errorMsg}`, 'error');
}

function resetRun(total, jobType = 'unfollow') {
  ensureDayCounter();
  state.running = true;
  state.stopRequested = false;
  state.jobType = jobType;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.total = total;
  state.processed = 0;
  state.successes = 0;
  state.failures = 0;
  state.lastMessage = "";
  state.lastUsername = "";
  state.lastError = null;
}

function endRun(reason) {
  state.running = false;
  state.finishedAt = new Date().toISOString();
  if (reason) log(reason);
  
  const duration = state.finishedAt && state.startedAt 
    ? Math.round((new Date(state.finishedAt) - new Date(state.startedAt)) / 1000)
    : 0;
  
  log(`Run completed in ${duration}s. Success: ${state.successes}, Failed: ${state.failures}`);
}

function getStats() {
  return {
    running: state.running,
    stopRequested: state.stopRequested,
    jobType: state.jobType,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    total: state.total,
    processed: state.processed,
    successes: state.successes,
    failures: state.failures,
    lastUsername: state.lastUsername,
    lastMessage: state.lastMessage,
    lastError: state.lastError,
    daily: {
      dayKey: state.dayKey,
      count: state.dailyCount,
    },
    progress: state.total > 0 ? Math.round((state.processed / state.total) * 100) : 0,
  };
}

module.exports = { 
  state, 
  log, 
  logError,
  resetRun, 
  endRun, 
  ensureDayCounter,
  getStats,
};