// State → DOM. Each function is responsible for one UI region.

import { state, els, TABS } from "./state.js";
import { fmt, relTime, untilTime, escapeHtml } from "./util.js";

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

export function renderImportStatus() {
  const s = state.importStatus;
  if (!s || !s.enabled) {
    els.importStatusEl.classList.add("hidden");
    return;
  }
  els.importStatusEl.classList.remove("hidden");
  const lastLine = s.lastImportedAt
    ? `last import: ${escapeHtml(s.lastImportedFile || "")} (@${escapeHtml(s.lastImportedOwner || "?")}, ${fmt(s.lastImportedCounts?.followers || 0)}f / ${fmt(s.lastImportedCounts?.following || 0)}g) ${relTime(s.lastImportedAt)}`
    : "no imports yet";
  const errLine = s.lastError
    ? ` · <span class="err">last error: ${escapeHtml(s.lastError.message)}</span>`
    : "";
  els.importStatusEl.innerHTML = `
    <span class="dot ok"></span>
    Auto-import watching <code>${escapeHtml(s.dir)}</code> · ${lastLine}${errLine}`;
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
    ? `last scan ${relTime(s.lastSuccessAt)} (${fmt(s.lastCounts?.followers || 0)}f / ${fmt(s.lastCounts?.following || 0)}g)`
    : "no successful scan yet";
  const schedule = s.intervalHours > 0
    ? `auto-scan every ${s.intervalHours}h${s.nextRunAt ? `, next ${untilTime(s.nextRunAt)}` : ""}`
    : "auto-scan off";
  const cost = typeof s.lastUsageUsd === "number" ? ` · last run $${s.lastUsageUsd.toFixed(2)}` : "";
  const err = s.lastError ? ` · <span class="err">${escapeHtml(s.lastError.message)}</span>` : "";
  const accept = s.pending
    ? ` <button class="inline-btn" data-act="accept" ${state.status?.running ? "disabled" : ""}>` +
      `Save anyway (${fmt(s.pending.followers)}f / ${fmt(s.pending.following)}g)</button>`
    : "";
  const dot = s.lastError ? "warn" : s.lastSuccessAt ? "ok" : "idle";

  el.innerHTML = `<span class="dot ${dot}"></span>Apify · ${last} · ${schedule}${cost}${err}${accept}`;
  const btn = el.querySelector('[data-act="accept"]');
  if (btn && onAccept) btn.onclick = onAccept;
}

export function renderScanInfo() {
  const snap = state.snapshot;
  const running = state.status?.running;
  const jobType = state.status?.jobType;
  const isScanning = running && (jobType === "scan" || jobType === "apify-scan");

  els.scanBtn.disabled = !!running;
  els.scanBtn.textContent = running && jobType === "scan"
    ? "Scanning..."
    : snap ? "Re-scan" : "Scan now";
  els.ownerInput.disabled = !!running;

  const apifyReady = !!state.apifyStatus?.enabled;
  els.apifyBtn.disabled = !!running || !apifyReady;
  els.apifyBtn.title = apifyReady ? "" : "Set APIFY_TOKENS in .env to enable";
  els.apifyBtn.textContent = running && jobType === "apify-scan" ? "Apify running..." : "Scan via Apify";

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
  el.innerHTML = `
    <span class="history-label">Action memory</span>
    <span class="history-stat">${fmt(counts.followed)} followed</span>
    <span class="sep">·</span>
    <span class="history-stat">${fmt(counts.unfollowed)} unfollowed</span>
    <span class="history-hint">— these accounts are auto-skipped next time</span>
    <span style="flex: 1"></span>
    <button class="history-clear" data-which="all" ${running ? "disabled" : ""}>Clear memory</button>`;
  const btn = el.querySelector(".history-clear");
  if (btn && onClear) btn.onclick = () => onClear(btn.dataset.which);
}

export function renderLogs() {
  const logs = state.status?.logs;
  if (!logs?.length) {
    els.logs.innerHTML = `<span class="empty">No log entries yet.</span>`;
    return;
  }
  // Logs are newest-first. Preserve scroll if the user has scrolled away from
  // the top (reading history); otherwise pin them to the newest entry.
  const wasAtTop = els.logs.scrollTop < 24;
  els.logs.innerHTML = logs.map((entry) => {
    if (typeof entry === "string") {
      return `<div class="log-line log-info">${escapeHtml(entry)}</div>`;
    }
    const lvl = entry.level || "info";
    const ts = entry.timestamp ? `[${escapeHtml(entry.timestamp)}] ` : "";
    return `<div class="log-line log-${escapeHtml(lvl)}">${ts}${escapeHtml(entry.message || "")}</div>`;
  }).join("");
  if (wasAtTop) els.logs.scrollTop = 0;
}
