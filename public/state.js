// Shared mutable state + cached DOM refs. Imported by render.js and app.js.

export const TABS = [
  { id: "notFollowingBack", label: "unfollowers" },
  { id: "mutuals", label: "Mutuals" },
  { id: "fans", label: "Fans" },
];

export const state = {
  status: null,        // last /api/unfollow/status response
  statusError: null,   // string | null
  snapshot: null,      // { owner, scannedAt, counts, lists }
  importStatus: null,  // last /api/import/status response (status field)
  selected: new Set(),
  tab: "notFollowingBack",
  filter: "",
  pollHandle: null,
};

const $ = (id) => document.getElementById(id);

export const els = {
  pill: $("backend-pill"),
  scanInfo: $("scan-info"),
  ownerInput: $("owner-input"),
  scanBtn: $("scan-btn"),
  importBtn: $("import-btn"),
  importInput: $("import-input"),
  importStatusEl: $("import-status"),
  results: $("results-section"),
  stats: $("stats"),
  browse: $("browse-section"),
  tabs: $("tabs"),
  filter: $("filter-input"),
  selectAll: $("select-all-btn"),
  clearSel: $("clear-sel-btn"),
  listCount: $("list-count"),
  list: $("user-list"),
  growSource: $("grow-source"),
  growType: $("grow-type"),
  growCount: $("grow-count"),
  growBtn: $("grow-btn"),
  runStatus: $("run-status"),
  runMeta: $("run-meta"),
  unfollowBtn: $("unfollow-btn"),
  stopBtn: $("stop-btn"),
  progressWrap: $("progress-wrap"),
  progressBar: $("progress-bar"),
  progressMeta: $("progress-meta"),
  logs: $("logs"),
  errorBanner: $("error-banner"),
};
