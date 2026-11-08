// Boot file: lifecycle (polling, snapshot loading) + DOM event wiring.
// All rendering lives in render.js, all backend calls in api.js.

import { state, els } from "./state.js";
import { api } from "./api.js";
import { showError } from "./util.js";
import { classifyAndParseFiles } from "./ig-parser.js";
import {
  renderPill,
  renderScanInfo,
  renderBrowse,
  renderList,
  renderRunBar,
  renderLogs,
  renderImportStatus,
  renderHistory,
  renderApifyStatus,
} from "./render.js";
import {
  renderDashboard,
  renderChart,
  renderFeeds,
  renderFreshness,
  renderSidebar,
} from "./dashboard.js";

// ---------- Routing (#dashboard | #review | #grow | #activity | #sources) ----------

const VIEWS = ["dashboard", "review", "grow", "activity", "sources"];

function applyRoute() {
  const name = location.hash.slice(1);
  const view = VIEWS.includes(name) ? name : "dashboard";
  let title = "Dashboard";
  document.querySelectorAll(".view").forEach((v) => {
    const on = v.dataset.view === view;
    v.classList.toggle("hidden", !on);
    if (on) title = v.dataset.title;
  });
  document.querySelectorAll(".nav-item").forEach((a) => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  document.getElementById("page-title").textContent = title;
  document.title = view === "dashboard" ? "Instagrow" : `${title} · Instagrow`;
  document.getElementById("topbar-update").classList.toggle("hidden", view === "sources");
  // The chart measures its container, which has no width while hidden.
  if (view === "dashboard") renderChart();
}
window.addEventListener("hashchange", applyRoute);

// Overlap strip / legend → open that list in Review.
function pickList(tab) {
  state.tab = tab;
  renderBrowse(handleTabChange);
  renderRunBar();
  location.hash = "#review";
}

// ---------- Actions timeline (chart + feeds) ----------

const TIMELINE_DAYS = 90; // fetch the widest range once; the chart slices it
try {
  const saved = Number(localStorage.getItem("instagrow-range"));
  state.range = [14, 30, 90].includes(saved) ? saved : 30;
} catch { state.range = 30; }

async function loadTimeline() {
  try {
    state.timeline = await api.timeline(TIMELINE_DAYS);
    renderChart();
    renderFeeds();
  } catch {}
}

document.querySelectorAll("#range [data-range]").forEach((btn) => {
  btn.onclick = () => {
    state.range = Number(btn.dataset.range);
    try { localStorage.setItem("instagrow-range", String(state.range)); } catch {}
    renderChart();
  };
});

// Redraw the chart when its card changes width (window resize, sidebar breakpoint).
let chartWidth = 0;
new ResizeObserver((entries) => {
  const w = Math.round(entries[0].contentRect.width);
  if (w && w !== chartWidth) { chartWidth = w; renderChart(); }
}).observe(document.getElementById("activity-chart"));

// ---------- Polling /api/unfollow/status ----------

async function pollOnce() {
  try {
    state.status = await api.status();
    state.statusError = null;
  } catch (err) {
    state.statusError = err.message;
  }
  // Import status is cheaper + less frequent — refresh on each poll, but
  // don't block the main poll on failure.
  try {
    const r = await api.importStatus();
    state.importStatus = r.status;
  } catch {}
  // Action-memory counts (followed/unfollowed). Cheap; updates live during a run.
  try {
    const h = await api.history();
    state.history = h.counts;
  } catch {}
  try {
    const a = await api.apifyStatus();
    state.apifyStatus = a.status;
  } catch {}
  renderPill();
  renderScanInfo();
  renderImportStatus();
  renderApifyStatus(handleApifyAccept);
  renderRunBar();
  renderHistory(handleClearHistory);
  renderLogs();
  renderSidebar();
  renderFreshness();
  // New follows/unfollows recorded → refresh the chart, feeds and hero counts.
  const actions = (state.history?.followed || 0) + (state.history?.unfollowed || 0);
  if (state.history && actions !== state.lastActionCount) {
    const first = state.lastActionCount === undefined;
    state.lastActionCount = actions;
    loadTimeline();
    if (state.snapshot) renderDashboard(pickList); // hero shows the unfollowed total
    // The "not following back" list excludes unfollowed accounts server-side.
    if (!first && !state.status?.running) loadSnapshotIfAny();
  }
  // A run just ended → reload lists so the review list drops what was unfollowed.
  if (state.wasRunning && !state.status?.running) loadSnapshotIfAny();
  state.wasRunning = !!state.status?.running;
  // If auto-import landed a new snapshot since last poll, reflect it in the UI.
  const lastIso = state.importStatus?.lastImportedAt || null;
  if (lastIso && state.lastImportedSeen !== lastIso) {
    state.lastImportedSeen = lastIso;
    loadSnapshotIfAny();
  }
  // Same for an Apify scan (manual or scheduled) that just saved a snapshot.
  const apifyIso = state.apifyStatus?.lastSuccessAt || null;
  if (apifyIso && state.lastApifySeen !== apifyIso) {
    state.lastApifySeen = apifyIso;
    loadSnapshotIfAny();
  }
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(state.pollHandle);
  // Tight cadence while a job is running so the log feed updates near-real-time.
  const delay = state.status?.running ? 800 : 4000;
  state.pollHandle = setTimeout(pollOnce, delay);
}

// ---------- Snapshot bootstrap ----------

async function loadSnapshotIfAny() {
  try {
    const r = await api.scanLatest();
    if (r.snapshot) {
      state.snapshot = r.snapshot;
      state.selected.clear();
      renderScanInfo();
      renderDashboard(pickList);
      renderBrowse(handleTabChange);
      renderRunBar();
      renderSidebar();
      renderFreshness();
    } else {
      renderDashboard(pickList);
      renderBrowse(handleTabChange);
    }
  } catch (err) {
    showError(`Could not load latest snapshot: ${err.message}`);
  }
}

function handleTabChange() {
  renderBrowse(handleTabChange);
  renderRunBar();
}

// ---------- Theme (light / dark; no saved choice = follow the OS) ----------

els.themeBtn.onclick = () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try { localStorage.setItem("instagrow-theme", next); } catch {}
};

async function handleClearHistory(which) {
  const label = which === "all" ? "all action memory" : `${which} memory`;
  if (!confirm(`Clear ${label}? Previously-actioned accounts can be targeted again.`)) return;
  try {
    const r = await api.historyClear(which);
    state.history = r.counts;
    renderHistory(handleClearHistory);
    // The unfollow list is filtered by history server-side, so refresh it —
    // accounts we'd unfollowed before can reappear once memory is cleared.
    await loadSnapshotIfAny();
  } catch (err) {
    showError(err.message);
  }
}

async function handleApifyAccept() {
  const p = state.apifyStatus?.pending;
  if (!p) return;
  const ok = confirm(
    `Save the held-back Apify result (${p.followers} followers, ${p.following} following) as your snapshot?\n\n` +
    `It was held back because it looks incomplete. If it is truncated, people who DO follow you ` +
    `will show up under "not following back".`
  );
  if (!ok) return;
  try {
    await api.apifyAccept();
    await loadSnapshotIfAny();
    pollOnce();
  } catch (err) {
    showError(err.message);
  }
}

// ---------- DOM events ----------

els.apifyBtn.onclick = async () => {
  const owner = els.ownerInput.value.trim().replace(/^@/, "") || state.snapshot?.owner || "";
  const c = state.snapshot?.counts;
  const est = c ? c.followers + c.following : 0;
  // Apify bills per result; $1.15/1,000 is the cheapest listed tier.
  const costLine = est
    ? `\n\n~${est.toLocaleString()} results based on your last snapshot. Apify bills per result ` +
      `(from $1.15 per 1,000), so expect at least ~$${((est * 1.15) / 1000).toFixed(2)}.`
    : "";
  if (!confirm(`Fetch ${owner ? "@" + owner : "your"} followers + following via Apify?${costLine}`)) return;
  try {
    await api.apifyScan(owner || null);
    pollOnce();
  } catch (err) {
    showError(err.message);
  }
};

els.scanBtn.onclick = async () => {
  try {
    const owner = els.ownerInput.value.trim().replace(/^@/, "");
    await api.scanStart(owner || null);
    pollOnce();
    // Poll for snapshot completion: once status.running flips back to false
    // (with at least 3s grace so we don't see the pre-start idle state),
    // reload the snapshot from disk.
    const startTime = Date.now();
    const checkSnapshot = setInterval(async () => {
      if (
        state.status &&
        !state.status.running &&
        Date.now() - startTime > 3000
      ) {
        clearInterval(checkSnapshot);
        await loadSnapshotIfAny();
      }
      if (Date.now() - startTime > 1000 * 60 * 15) clearInterval(checkSnapshot);
    }, 3000);
  } catch (err) {
    showError(err.message);
  }
};

els.importBtn.onclick = () => els.importInput.click();

els.importInput.onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = ""; // reset so picking the same files again re-fires onchange
  if (files.length === 0) return;

  const owner = els.ownerInput.value.trim().replace(/^@/, "");
  if (!owner) {
    return showError("Enter your Instagram username before importing.");
  }

  try {
    const { followers, following, errors } = await classifyAndParseFiles(files);
    if (errors.length) {
      showError(`Some files were skipped: ${errors.join("; ")}`);
    }
    if (followers.length === 0 && following.length === 0) {
      return showError(
        "No followers or following found in those files. Make sure you selected followers_*.json and following.json from your IG data download."
      );
    }
    await api.scanUpload({ owner, followers, following });
    state.snapshot = null;
    await loadSnapshotIfAny();
    pollOnce();
  } catch (err) {
    showError(err.message);
  }
};

els.filter.oninput = (e) => {
  state.filter = e.target.value;
  renderList();
};

els.selectAll.onclick = () => {
  if (!state.snapshot || state.tab !== "notFollowingBack") return;
  const all = state.snapshot.lists.notFollowingBack;
  const q = state.filter.trim().toLowerCase();
  const filtered = q ? all.filter((u) => u.includes(q)) : all;
  filtered.forEach((u) => state.selected.add(u));
  renderList();
  renderRunBar();
};

els.clearSel.onclick = () => {
  state.selected.clear();
  renderList();
  renderRunBar();
};

els.unfollowBtn.onclick = async () => {
  const list = Array.from(state.selected);
  if (!list.length) return;
  if (!confirm(`Unfollow ${list.length} account(s)?`)) return;
  try {
    await api.unfollowStart(list);
    pollOnce();
  } catch (err) {
    showError(err.message);
  }
};

els.stopBtn.onclick = async () => {
  try {
    await api.jobStop();
    pollOnce();
  } catch (err) {
    showError(err.message);
  }
};

els.growBtn.onclick = async () => {
  const src = els.growSource.value.trim().replace(/^@/, "");
  const type = els.growType.value;
  const count = Math.max(1, parseInt(els.growCount.value, 10) || 0);
  if (!src) return showError("Enter a source username.");
  if (!confirm(`Scrape @${src}'s ${type} and follow ${count} accounts?`)) return;
  try {
    await api.followStart({ sourceUsername: src, sourceType: type, count });
    pollOnce();
  } catch (err) {
    showError(err.message);
  }
};

// ---------- Boot ----------

applyRoute();
loadSnapshotIfAny();
pollOnce();
