// State → DOM. Each function is responsible for one UI region.

import { state, els, TABS } from "./state.js";
import { fmt, relTime, escapeHtml } from "./util.js";

export function renderPill() {
  const dot = els.pill.querySelector(".dot");
  const label = els.pill.querySelector(".label");
  dot.className = "dot";
  if (state.statusError) {
    dot.classList.add("err");
    label.textContent = "Backend offline";
    els.pill.title = state.statusError;
  } else if (state.status) {
    dot.classList.add("ok");
    label.textContent = "Backend connected";
    els.pill.title = "";
  } else {
    label.textContent = "Connecting...";
  }
}

export function renderScanInfo() {
  const snap = state.snapshot;
  const running = state.status?.running;
  const isScanning = running && state.status?.jobType === "scan";

  els.scanBtn.disabled = !!running;
  els.scanBtn.textContent = isScanning
    ? "Scanning..."
    : snap ? "Re-scan" : "Scan now";
  els.ownerInput.disabled = !!running;

  if (isScanning) {
    els.scanInfo.classList.remove("has-data");
    els.scanInfo.innerHTML =
      `<div class="scan-info-line">${escapeHtml(state.status?.lastMessage || "Working...")}</div>`;
    return;
  }
  if (!snap) {
    els.scanInfo.classList.remove("has-data");
    els.scanInfo.innerHTML =
      `<div class="scan-info-line">No snapshot yet — click <strong>Scan now</strong> to fetch your lists.</div>`;
    return;
  }
  const ageMs = Date.now() - new Date(snap.scannedAt).getTime();
  const stale = ageMs > 1000 * 60 * 60 * 24; // > 1 day
  els.scanInfo.classList.add("has-data");
  els.scanInfo.innerHTML = `
    <div class="scan-info-line">
      <strong>@${escapeHtml(snap.owner)}</strong>
      <span>·</span>
      <span class="${stale ? "stale" : ""}">scanned ${relTime(snap.scannedAt)}</span>
      <span>·</span>
      <span>${fmt(snap.counts.followers)} followers, ${fmt(snap.counts.following)} following</span>
    </div>`;
}

function statCard(label, value) {
  return `<div class="stat"><div class="label">${label}</div><div class="value">${fmt(value)}</div></div>`;
}

export function renderResults() {
  const snap = state.snapshot;
  if (!snap) { els.results.classList.add("hidden"); return; }
  els.results.classList.remove("hidden");
  const c = snap.counts;
  els.stats.innerHTML = [
    statCard("Followers", c.followers),
    statCard("Following", c.following),
    statCard("Not following back", c.notFollowingBack),
    statCard("Mutuals", c.mutuals),
    statCard("Fans", c.fans),
  ].join("");
}

export function renderBrowse(onTabChange) {
  const snap = state.snapshot;
  if (!snap) { els.browse.classList.add("hidden"); return; }
  els.browse.classList.remove("hidden");

  els.tabs.innerHTML = TABS.map((t) => `
    <button class="tab ${state.tab === t.id ? "active" : ""}" data-tab="${t.id}">
      ${t.label}<span class="num">${fmt(snap.lists[t.id].length)}</span>
    </button>`).join("");

  els.tabs.querySelectorAll(".tab").forEach((btn) => {
    btn.onclick = () => {
      state.tab = btn.dataset.tab;
      if (onTabChange) onTabChange();
    };
  });

  renderList();
}

export function renderList() {
  const snap = state.snapshot;
  if (!snap) return;
  const all = snap.lists[state.tab] || [];
  const q = state.filter.trim().toLowerCase();
  const filtered = q ? all.filter((u) => u.includes(q)) : all;

  const selectable = state.tab === "notFollowingBack";

  els.selectAll.style.display = selectable ? "" : "none";
  els.clearSel.style.display = selectable ? "" : "none";
  els.selectAll.disabled = !filtered.length;
  els.clearSel.disabled = !state.selected.size;
  els.clearSel.textContent = `Clear (${state.selected.size})`;

  els.listCount.textContent = `${filtered.length} shown` +
    (selectable ? ` · ${state.selected.size} selected` : "");

  if (filtered.length === 0) {
    els.list.innerHTML = `<div class="row empty">No usernames to display.</div>`;
    return;
  }
  els.list.innerHTML = filtered.map((u) => {
    const cb = selectable
      ? `<input type="checkbox" data-u="${escapeHtml(u)}" ${state.selected.has(u) ? "checked" : ""} />`
      : "";
    return `<div class="row">${cb}<span>${escapeHtml(u)}</span></div>`;
  }).join("");

  if (selectable) {
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.onchange = () => {
        const u = cb.dataset.u;
        if (cb.checked) state.selected.add(u); else state.selected.delete(u);
        // Cheap update: just refresh count + run-bar, not full list re-render.
        els.listCount.textContent = `${filtered.length} shown · ${state.selected.size} selected`;
        els.clearSel.disabled = !state.selected.size;
        els.clearSel.textContent = `Clear (${state.selected.size})`;
        renderRunBar();
      };
    });
  }
}

export function renderRunBar() {
  const s = state.status;
  const running = !!s?.running;
  const jobType = s?.jobType;

  const dot = els.runStatus.querySelector(".status-dot");
  const text = els.runStatus.querySelector(".text");
  dot.className = "status-dot" + (running ? " running" : "");
  text.textContent = running ? "Running" : "Idle";

  let meta = "";
  if (s) {
    if (running && jobType) meta += `<span class="badge">${jobType}</span>`;
    meta += `Daily ${s.daily?.count ?? 0}/${s.daily?.limit ?? "?"}`;
    if (typeof s.queueSize === "number" && s.queueSize > 0) {
      meta += ` <span class="sep">·</span> Queue ${s.queueSize}`;
    }
    if (s.dryRun) {
      meta += ` <span class="sep">·</span> <span class="badge warn-badge">DRY RUN</span>`;
    }
  }
  els.runMeta.innerHTML = meta;

  els.unfollowBtn.classList.toggle("hidden", running);
  els.stopBtn.classList.toggle("hidden", !running);
  els.unfollowBtn.disabled = !state.selected.size;
  els.unfollowBtn.textContent = `Unfollow selected (${state.selected.size})`;

  els.growBtn.disabled = running;
  els.growSource.disabled = running;
  els.growType.disabled = running;
  els.growCount.disabled = running;

  if (running && s?.total > 0) {
    const pct = Math.round((s.processed / s.total) * 100);
    els.progressWrap.classList.remove("hidden");
    els.progressBar.style.width = `${pct}%`;
    const last = s.lastUsername ? ` · last: @${escapeHtml(s.lastUsername)}` : "";
    els.progressMeta.innerHTML = `<span>${s.processed} / ${s.total} processed${last}</span><span>${pct}%</span>`;
  } else {
    els.progressWrap.classList.add("hidden");
  }
}

export function renderLogs() {
  const logs = state.status?.logs;
  if (!logs?.length) {
    els.logs.innerHTML = `<span class="empty">No log entries yet.</span>`;
    return;
  }
  els.logs.textContent = logs.join("\n");
}
