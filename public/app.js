// Boot file: lifecycle (polling, snapshot loading) + DOM event wiring.
// All rendering lives in render.js, all backend calls in api.js.

import { state, els } from "./state.js";
import { api } from "./api.js";
import { showError } from "./util.js";
import {
  renderPill,
  renderScanInfo,
  renderResults,
  renderBrowse,
  renderList,
  renderRunBar,
  renderLogs,
} from "./render.js";

// ---------- Polling /api/unfollow/status ----------

async function pollOnce() {
  try {
    state.status = await api.status();
    state.statusError = null;
  } catch (err) {
    state.statusError = err.message;
  }
  renderPill();
  renderScanInfo();
  renderRunBar();
  renderLogs();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(state.pollHandle);
  const delay = state.status?.running ? 2000 : 5000;
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
      renderResults();
      renderBrowse(handleTabChange);
      renderRunBar();
    }
  } catch (err) {
    showError(`Could not load latest snapshot: ${err.message}`);
  }
}

function handleTabChange() {
  renderBrowse(handleTabChange);
  renderRunBar();
}

// ---------- DOM events ----------

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

loadSnapshotIfAny();
pollOnce();
