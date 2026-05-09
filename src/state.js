const MAX_LOG_ENTRIES = 400;

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

function ensureDayCounter() {
  const key = nowDayKey();
  if (state.dayKey !== key) {
    state.dayKey = key;
    state.dailyCount = 0;
    log(`Day counter reset for ${key}`);
  }
}

function log(line, level = 'info') {
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}] ${line}`;
  
  state.lastMessage = line;
  state.logs.unshift({ timestamp, message: line, level });
  
  if (state.logs.length > MAX_LOG_ENTRIES) {
    state.logs.length = MAX_LOG_ENTRIES;
  }

  // Also log to console
  const consoleMsg = `[${level.toUpperCase()}] ${line}`;
  switch(level) {
    case 'error':
      console.error(consoleMsg);
      break;
    case 'warn':
      console.warn(consoleMsg);
      break;
    default:
      console.log(consoleMsg);
  }
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