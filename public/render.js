// State → DOM. Each function is responsible for one UI region.

import { state, els, TABS } from "./state.js";
import { fmt, relTime, untilTime, escapeHtml } from "./util.js";

const JOB_LABELS = {
  unfollow: "Unfollowing",
  follow: "Following",
  scan: "Scanning",
  "apify-scan": "Apify scan",
};
const MAX_LOG_LINES = 400; // the backend keeps more; the UI only needs the recent tail

export function renderPill() {
  const dot = els.pill.querySelector(".dot");
  const label = els.pill.querySelector(".label");
  dot.className = "dot";
  if (state.statusError) {
    dot.classList.add("err");
    label.textContent = "Offline";
    els.pill.title = state.statusError;
  } else if (state.status) {
    dot.classList.add("ok");
    label.textContent = "Connected";
    els.pill.title = "Backend connected";
  } else {
    label.textContent = "Connecting…";
  }
}

export function renderImportStatus() {
  const s = state.importStatus;
  if (!s || !s.enabled) {
    els.importStatusEl.classList.add("hidden");
    return;
  }
  els.importStatusEl.classList.remove("hidden");
  const last = s.lastImportedAt
    ? `Last import ${relTime(s.lastImportedAt)}&nbsp;· <span class="muted">${fmt(s.lastImportedCounts?.followers || 0)} / ${fmt(s.lastImportedCounts?.following || 0)}</span>`
    : `<span class="muted">No imports yet</span>`;
  const err = s.lastError ? `<br><span class="err">${escapeHtml(s.lastError.message)}</span>` : "";
  els.importStatusEl.title = s.lastImportedFile ? `Last file: ${s.lastImportedFile}` : "";
  els.importStatusEl.innerHTML =
    `<span class="dot ${s.lastError ? "warn" : "ok"}"></span>` +
    `<span class="status-text">Watching <code>${escapeHtml(s.dir)}</code><br>${last}${err}</span>`;
}

export function renderApifyStatus(onAccept) {
  const s = state.apifyStatus;
  const el = els.apifyStatusEl;
  if (!s || !s.enabled) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");

  const last = s.lastSuccessAt
    ? `Last scan ${relTime(s.lastSuccessAt)}&nbsp;· <span class="muted">${fmt(s.lastCounts?.followers || 0)} / ${fmt(s.lastCounts?.following || 0)}</span>`
    : `<span class="muted">No scan yet</span>`;
  const schedule = s.intervalHours > 0
    ? `Auto every ${s.intervalHours}h${s.nextRunAt ? `, next ${untilTime(s.nextRunAt)}` : ""}`
    : `<span class="muted">Manual only</span>`;
  const cost = typeof s.lastUsageUsd === "number" ? `&nbsp;· $${s.lastUsageUsd.toFixed(2)} last run` : "";
  const err = s.lastError ? `<br><span class="err">${escapeHtml(s.lastError.message)}</span>` : "";
  const accept = s.pending
    ? ` <button class="inline-btn" type="button" data-act="accept" ${state.status?.running ? "disabled" : ""}>` +
      `Save anyway (${fmt(s.pending.followers)} / ${fmt(s.pending.following)})</button>`
    : "";
  const dot = s.lastError ? "warn" : s.lastSuccessAt ? "ok" : "idle";

  el.innerHTML = `<span class="dot ${dot}"></span><span class="status-text">${last}&nbsp;· ${schedule}${cost}${err}${accept}</span>`;
  const btn = el.querySelector('[data-act="accept"]');
  if (btn && onAccept) btn.onclick = onAccept;
}

// Top-bar account summary + the scan buttons' state.
export function renderScanInfo() {
  const snap = state.snapshot;
  const running = !!state.status?.running;
  const jobType = state.status?.jobType;
  const isScanning = running && (jobType === "scan" || jobType === "apify-scan");

  els.scanBtn.disabled = running;
  els.scanBtn.textContent = running && jobType === "scan" ? "Scanning…" : "Scan";
  els.ownerInput.disabled = running;

  const apifyReady = !!state.apifyStatus?.enabled;
  els.apifyBtn.disabled = running || !apifyReady;
  els.apifyBtn.title = apifyReady ? "" : "Set APIFY_TOKENS in .env to enable";
  els.apifyBtn.textContent = running && jobType === "apify-scan" ? "Running…" : "Scan";

  if (isScanning) {
    els.scanInfo.innerHTML =
      `<span class="account-busy">${escapeHtml(state.status?.lastMessage || "Updating lists…")}</span>`;
    return;
  }
  if (!snap) {
    els.scanInfo.innerHTML = `<span class="account-empty">No lists yet</span>`;
    return;
  }
  const stale = Date.now() - new Date(snap.scannedAt).getTime() > 1000 * 60 * 60 * 24;
  els.scanInfo.innerHTML =
    `<span class="account-handle">@${escapeHtml(snap.owner)}</span>` +
    `<span class="sep">·</span>` +
    `<span class="${stale ? "stale" : ""}" title="${escapeHtml(new Date(snap.scannedAt).toLocaleString())}">` +
    `lists updated ${relTime(snap.scannedAt)}</span>`;
}

export function renderBrowse(onTabChange) {
  const snap = state.snapshot;
  const empty = document.getElementById("review-empty");
  if (empty) empty.classList.toggle("hidden", !!snap);
  if (!snap) { els.browse.classList.add("hidden"); return; }
  els.browse.classList.remove("hidden");

  els.tabs.innerHTML = TABS.map((t) => `
    <button class="tab ${state.tab === t.id ? "active" : ""}" type="button" role="tab"
      aria-selected="${state.tab === t.id}" data-tab="${t.id}">
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

function countLabel(shown, selectable) {
  return `${fmt(shown)} shown` + (selectable ? ` · ${fmt(state.selected.size)} selected` : "");
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
  els.listCount.textContent = countLabel(filtered.length, selectable);

  if (filtered.length === 0) {
    els.list.innerHTML = `<div class="row empty">${q ? "No usernames match your search." : "Nobody in this list."}</div>`;
    return;
  }

  const link = (u) =>
    `<a class="row-link" href="https://www.instagram.com/${encodeURIComponent(u)}/" target="_blank" rel="noopener" title="Open profile" aria-label="Open @${escapeHtml(u)} on Instagram">` +
    `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6 3h7v7M13 3 5 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`;

  els.list.innerHTML = filtered.map((u) => {
    const name = `<span class="uname">${escapeHtml(u)}</span>`;
    if (!selectable) return `<div class="row">${name}${link(u)}</div>`;
    const on = state.selected.has(u);
    return `<label class="row${on ? " is-selected" : ""}">` +
      `<input type="checkbox" data-u="${escapeHtml(u)}" ${on ? "checked" : ""} />${name}${link(u)}</label>`;
  }).join("");

  if (selectable) {
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.onchange = () => {
        const u = cb.dataset.u;
        if (cb.checked) state.selected.add(u); else state.selected.delete(u);
        cb.closest(".row").classList.toggle("is-selected", cb.checked);
        // Cheap update: counts + action button only, not a full list re-render.
        els.listCount.textContent = countLabel(filtered.length, true);
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
  els.runStatus.classList.toggle("is-running", running);
  text.textContent = running ? (JOB_LABELS[jobType] || "Running") : "Idle";

  // Daily quota meter, dry-run flag, last-run summary.
  let meta = "";
  if (s) {
    const count = s.daily?.count ?? 0;
    const limit = s.daily?.limit ?? 0;
    const pct = limit ? Math.min(100, Math.round((count / limit) * 100)) : 0;
    meta += `
      <div class="quota">
        <div class="quota-top">
          <span>Today's actions${s.dryRun ? ` <span class="badge">Dry run</span>` : ""}</span>
          <span class="num">${fmt(count)} / ${fmt(limit)}</span>
        </div>
        <div class="meter${pct >= 100 ? " is-full" : pct >= 80 ? " is-warn" : ""}"><span style="width: ${pct}%"></span></div>
      </div>`;
    if (!running && s.finishedAt && jobType) {
      meta += `<div class="last-run">Last run (${escapeHtml((JOB_LABELS[jobType] || jobType).toLowerCase())}) finished ${relTime(s.finishedAt)} · ` +
        `<strong>${fmt(s.successes || 0)}</strong> done, <strong>${fmt(s.failures || 0)}</strong> failed</div>`;
    }
  }
  els.runMeta.innerHTML = meta;

  els.stopBtn.classList.toggle("hidden", !running);
  els.unfollowBtn.disabled = running || !state.selected.size;
  els.unfollowBtn.textContent = running
    ? "Run in progress…"
    : `Unfollow selected (${fmt(state.selected.size)})`;

  els.growBtn.disabled = running;
  els.growSource.disabled = running;
  els.growType.disabled = running;
  els.growCount.disabled = running;

  if (running && s?.total > 0) {
    const pct = Math.round((s.processed / s.total) * 100);
    els.progressWrap.classList.remove("hidden");
    els.progressBar.style.width = `${pct}%`;
    const current = s.lastUsername ? `@${escapeHtml(s.lastUsername)}` : "";
    els.progressMeta.innerHTML =
      `<span><span class="num">${fmt(s.processed)}</span> of <span class="num">${fmt(s.total)}</span>` +
      `${s.failures ? ` · ${fmt(s.failures)} failed` : ""}</span>` +
      `<span class="current">${current}</span>`;
  } else {
    els.progressWrap.classList.add("hidden");
  }
}

export function renderHistory(onClear) {
  const el = els.historyBar;
  if (!el) return;
  const counts = state.history;
  if (!counts || (!counts.followed && !counts.unfollowed)) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const running = !!state.status?.running;
  el.classList.remove("hidden");
  el.title = "Accounts already followed or unfollowed are skipped automatically";
  el.innerHTML = `
    <span>Remembered:</span>
    <span class="history-stat"><span class="num">${fmt(counts.followed)}</span> followed</span>
    <span class="sep">·</span>
    <span class="history-stat"><span class="num">${fmt(counts.unfollowed)}</span> unfollowed</span>
    <button class="history-clear" type="button" data-which="all" ${running ? "disabled" : ""}>Clear</button>`;
  const btn = el.querySelector(".history-clear");
  if (btn && onClear) btn.onclick = () => onClear(btn.dataset.which);
}

function shortTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}

export function renderLogs() {
  const logs = state.status?.logs;
  if (!logs?.length) {
    els.logs.innerHTML = `<span class="empty">No log entries yet.</span>`;
    return;
  }
  // Newest first. Keep the reader's place if they've scrolled down into history.
  const wasAtTop = els.logs.scrollTop < 24;
  els.logs.innerHTML = logs.slice(0, MAX_LOG_LINES).map((entry) => {
    if (typeof entry === "string") {
      return `<div class="log-line log-info">${escapeHtml(entry)}</div>`;
    }
    const lvl = ["error", "warn"].includes(entry.level) ? entry.level : "info";
    const ts = entry.timestamp
      ? `<span class="ts" title="${escapeHtml(entry.timestamp)}">${shortTime(entry.timestamp)}</span> `
      : "";
    return `<div class="log-line log-${lvl}">${ts}${escapeHtml(entry.message || "")}</div>`;
  }).join("");
  if (wasAtTop) els.logs.scrollTop = 0;
}
