// Dashboard regions: KPI tiles, overlap strip, actions chart, follower changes,
// feeds, data freshness, and the sidebar run widget. Charts are hand-rolled SVG
// (the page's CSP only allows same-origin scripts).

import { state } from "./state.js";
import { fmt, relTime, escapeHtml } from "./util.js";

const $ = (id) => document.getElementById(id);

const JOB_LABELS = { unfollow: "Unfollowing", follow: "Following", scan: "Scanning", "apify-scan": "Apify scan" };
const SOURCE_LABELS = {
  data_download_auto: "Data download (auto)",
  data_download: "Data download",
  apify: "Apify scan",
  live_scan: "Live scan",
  live_scan_partial: "Live scan (partial)",
};

const dayDate = (key) => new Date(`${key}T00:00:00`);
const shortDay = (key) => dayDate(key).toLocaleDateString([], { month: "short", day: "numeric" });
const longDay = (key) => dayDate(key).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const shortDate = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
const profileUrl = (u) => `https://www.instagram.com/${encodeURIComponent(u)}/`;

/* ---------------- KPIs + overlap ---------------- */

function sparkline(values, w = 88, h = 28) {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 8)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<path class="spark-line" d="${d}"/><circle class="spark-dot" cx="${lx}" cy="${ly}" r="3.5"/></svg>`;
}

// Signed change vs the previous snapshot. `upIsGood` picks the colour; null = neutral.
function delta(curr, prev, sinceIso, upIsGood) {
  if (prev == null) return "";
  const d = curr - prev;
  const cls = d === 0 || upIsGood == null ? "flat" : (d > 0) === upIsGood ? "up-good" : "up-bad";
  const sign = d > 0 ? "▲ " : d < 0 ? "▼ " : "";
  return `<span class="delta ${cls}">${sign}${fmt(Math.abs(d))}</span> since ${shortDate(sinceIso)}`;
}

export function renderDashboard(onPickList) {
  const snap = state.snapshot;
  $("empty-state").classList.toggle("hidden", !!snap);
  $("dash").classList.toggle("hidden", !snap);
  if (!snap) return;

  const c = snap.counts;
  const points = snap.trend?.points || [];
  const prev = points.length >= 2 ? points[points.length - 2] : null;
  const last = points[points.length - 1];
  const rate = c.following ? (c.mutuals / c.following) * 100 : 0;

  // Focus card — the one hero number on this view.
  $("focus-card").innerHTML = `
    <div class="focus-label"><span class="focus-swatch"></span>Not following back</div>
    <div class="focus-value">${fmt(c.notFollowingBack)}</div>
    <p class="focus-desc">People you follow who don't follow you back.</p>
    <div class="focus-foot">
      <div class="focus-meta"><strong>${rate.toFixed(1)}%</strong>follow back</div>
      <div class="focus-meta"><strong>${fmt(state.history?.unfollowed || 0)}</strong>unfollowed</div>
      <a class="btn btn-primary" href="#review">Review list</a>
    </div>`;

  const followerSpark = sparkline(points.map((p) => p.followers));
  const tile = (label, value, foot, spark = "") => `
    <article class="card tile">
      <div class="tile-label">${label}</div>
      <div class="tile-body"><div class="tile-value">${fmt(value)}</div>${spark}</div>
      <div class="tile-foot">${foot}</div>
    </article>`;
  $("kpi-tiles").innerHTML = [
    tile("Followers", c.followers,
      prev ? delta(last.followers, prev.followers, prev.at, true) : "Trend starts after your next list update",
      followerSpark),
    tile("Following", c.following,
      prev ? delta(last.following, prev.following, prev.at, null) : "Accounts you follow"),
    tile("Mutuals", c.mutuals, `${rate.toFixed(1)}% of the accounts you follow`),
    tile("Fans", c.fans, "Follow you, you don't follow back"),
  ].join("");

  // Overlap strip: followers = fans + mutuals, following = mutuals + not-following-back.
  const fr = (n) => `minmax(40px, ${Math.max(n, 1)}fr)`;
  const seg = (id, cls, label, n) =>
    `<button class="seg ${cls}" type="button" data-tab="${id}" title="${label}: ${fmt(n)}" aria-label="${label}: ${fmt(n)}"></button>`;
  const key = (id, color, label, n) =>
    `<button type="button" data-tab="${id}"><span class="swatch" style="background: var(${color})"></span>${label} <b>${fmt(n)}</b></button>`;
  $("stats").innerHTML = `
    <div class="recon" style="grid-template-columns: ${fr(c.fans)} ${fr(c.mutuals)} ${fr(c.notFollowingBack)}">
      <div class="bracket bracket-top" style="grid-column: 1 / 3">Followers <b>${fmt(c.followers)}</b></div>
      ${seg("fans", "seg-fans", "Fans", c.fans)}
      ${seg("mutuals", "seg-mutuals", "Mutuals", c.mutuals)}
      ${seg("notFollowingBack", "seg-nfb", "Not following back", c.notFollowingBack)}
      <div class="bracket bracket-bottom" style="grid-column: 2 / 4">Following <b>${fmt(c.following)}</b></div>
    </div>
    <div class="overlap-legend">
      ${key("fans", "--fan", "Fans", c.fans)}
      ${key("mutuals", "--mutual", "Mutuals", c.mutuals)}
      ${key("notFollowingBack", "--signal", "Not following back", c.notFollowingBack)}
    </div>`;
  $("stats").querySelectorAll("[data-tab]").forEach((el) => {
    el.onclick = () => onPickList && onPickList(el.dataset.tab);
  });

  renderChanges();
}

/* ---------------- Follower changes ---------------- */

function renderChanges() {
  const ch = state.snapshot?.trend?.changes;
  const el = $("changes");
  if (!ch) {
    $("changes-sub").textContent = "Compared with your previous list update";
    el.innerHTML = `<div class="change-empty">
      <p>Each time your lists update, Instagrow compares your followers with the previous update, so you can see who started and who stopped following you.</p>
      <p>The first comparison appears after your next import or scan.</p></div>`;
    return;
  }
  $("changes-sub").textContent = ch.since ? `Since ${shortDate(ch.since)}` : "Since your previous update";
  const people = ch.lostList.length
    ? `<ul class="people">${ch.lostList.map((u) =>
        `<li><a href="${profileUrl(u)}" target="_blank" rel="noopener">@${escapeHtml(u)}</a></li>`).join("")}</ul>` +
      (ch.lost > ch.lostList.length ? `<p class="fine-print">Showing ${fmt(ch.lostList.length)} of ${fmt(ch.lost)}.</p>` : "")
    : `<p class="change-empty">Nobody unfollowed you in this period.</p>`;
  el.innerHTML = `
    <div class="change-stats">
      <div class="change-stat"><div class="label">New followers</div><div class="value">+${fmt(ch.gained)}</div></div>
      <div class="change-stat"><div class="label">Unfollowed you</div><div class="value">−${fmt(ch.lost)}</div></div>
    </div>
    <p class="change-head">Who unfollowed you</p>
    ${people}`;
}

/* ---------------- Actions chart ---------------- */

function bucketize(days, range) {
  const slice = days.slice(-range);
  if (range <= 30) {
    return slice.map((d) => ({ key: d.date, label: shortDay(d.date), title: longDay(d.date), u: d.unfollowed, f: d.followed }));
  }
  // Weekly buckets, aligned so the last one ends today.
  const out = [];
  for (let end = slice.length; end > 0; end -= 7) {
    const wk = slice.slice(Math.max(0, end - 7), end);
    out.unshift({
      key: wk[0].date,
      label: shortDay(wk[0].date),
      title: `${shortDay(wk[0].date)} – ${shortDay(wk[wk.length - 1].date)}`,
      u: wk.reduce((s, d) => s + d.unfollowed, 0),
      f: wk.reduce((s, d) => s + d.followed, 0),
    });
  }
  return out;
}

function niceTicks(maxVal) {
  if (maxVal <= 0) return [0, 1];
  const rough = maxVal / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const n = rough / pow;
  const step = Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
  const ticks = [];
  for (let t = 0; t <= Math.ceil(maxVal / step) * step; t += step) ticks.push(t);
  return ticks;
}

// Rect with 4px rounded top corners, square at the bottom (baseline side).
function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function renderChart() {
  const el = $("activity-chart");
  const tl = state.timeline;
  const range = state.range;
  document.querySelectorAll("#range [data-range]").forEach((b) =>
    b.setAttribute("aria-pressed", String(Number(b.dataset.range) === range)));
  if (!tl) { el.innerHTML = `<div class="chart-empty">Loading…</div>`; return; }

  const data = bucketize(tl.days, range);
  const weekly = range > 30;
  const totU = data.reduce((s, d) => s + d.u, 0);
  const totF = data.reduce((s, d) => s + d.f, 0);
  $("chart-sub").textContent = `Follows and unfollows recorded per ${weekly ? "week" : "day"}, last ${range} days`;
  $("chart-legend").innerHTML =
    `<span><span class="swatch" style="background: var(--series-1)"></span>Unfollowed <b>${fmt(totU)}</b></span>` +
    `<span><span class="swatch" style="background: var(--series-2)"></span>Followed <b>${fmt(totF)}</b></span>`;
  $("chart-table").innerHTML = `<table class="data"><thead><tr><th>${weekly ? "Week" : "Day"}</th><th class="n">Unfollowed</th><th class="n">Followed</th></tr></thead><tbody>` +
    [...data].reverse().map((d) => `<tr><td>${d.title}</td><td class="n">${fmt(d.u)}</td><td class="n">${fmt(d.f)}</td></tr>`).join("") +
    `</tbody></table>`;

  if (totU + totF === 0) {
    el.innerHTML = `<div class="chart-empty">No follows or unfollows recorded in the last ${range} days.</div>`;
    return;
  }

  const W = Math.max(280, el.clientWidth || 640);
  const H = 220;
  const m = { top: 20, right: 4, bottom: 26, left: 34 };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const ticks = niceTicks(Math.max(...data.map((d) => d.u + d.f)));
  const top = ticks[ticks.length - 1];
  const y = (v) => m.top + ph - (v / top) * ph;
  const base = m.top + ph;
  const n = data.length;
  const slot = pw / n;
  const bw = Math.max(2, Math.min(24, slot - Math.max(2, slot * 0.3)));

  let grid = "";
  ticks.forEach((t) => {
    const yy = Math.round(y(t)) + 0.5;
    grid += t === 0
      ? `<line class="baseline" x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}"/>`
      : `<line class="grid" x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}"/>`;
    grid += `<text class="tick" x="${m.left - 8}" y="${yy + 4}" text-anchor="end">${fmt(t)}</text>`;
  });

  let bands = "", bars = "", hits = "", labels = "";
  let peakI = 0;
  data.forEach((d, i) => { if (d.u + d.f > data[peakI].u + data[peakI].f) peakI = i; });

  data.forEach((d, i) => {
    const x = m.left + i * slot + (slot - bw) / 2;
    bands += `<rect class="band" data-i="${i}" x="${m.left + i * slot}" y="${m.top}" width="${slot}" height="${ph}" fill="transparent"/>`;
    const segs = [];
    if (d.u > 0) segs.push({ cls: "bar-1", h: Math.max((d.u / top) * ph, 2) });
    if (d.f > 0) segs.push({ cls: "bar-2", h: Math.max((d.f / top) * ph, 2) });
    let yTop = base;
    segs.forEach((s, k) => {
      const yy = yTop - (k > 0 ? 2 : 0) - s.h; // 2px surface gap between stacked segments
      bars += k === segs.length - 1
        ? `<path class="${s.cls}" d="${topRounded(x, yy, bw, s.h, 4)}"/>`
        : `<rect class="${s.cls}" x="${x}" y="${yy}" width="${bw}" height="${s.h}"/>`;
      yTop = yy;
    });
    if (i === peakI && segs.length) {
      labels += `<text class="cap" x="${x + bw / 2}" y="${yTop - 6}" text-anchor="middle">${fmt(d.u + d.f)}</text>`;
    }
    hits += `<rect class="hit" data-i="${i}" x="${m.left + i * slot}" y="${m.top}" width="${slot}" height="${ph + m.bottom}"/>`;
  });

  // X labels anchored on the newest bucket, ~6 across.
  const every = Math.max(1, Math.ceil(n / 6));
  let xl = "";
  data.forEach((d, i) => {
    if ((n - 1 - i) % every !== 0) return;
    const cx = m.left + i * slot + slot / 2;
    const anchor = cx < m.left + 24 ? "start" : cx > W - 24 ? "end" : "middle";
    xl += `<text class="tick" x="${cx}" y="${H - 6}" text-anchor="${anchor}">${d.label}</text>`;
  });

  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Actions per ${weekly ? "week" : "day"}, last ${range} days: ${fmt(totU)} unfollowed, ${fmt(totF)} followed">
      ${grid}<g class="bands">${bands}</g>${bars}${labels}${xl}<g>${hits}</g></svg>`;

  const tip = $("chart-tip");
  const bandEls = el.querySelectorAll(".band");
  el.querySelectorAll(".hit").forEach((h) => {
    const i = Number(h.dataset.i);
    const d = data[i];
    h.addEventListener("mouseenter", () => {
      bandEls[i].setAttribute("fill", "var(--rule-soft)");
      tip.innerHTML = `<div class="chart-tip-title">${d.title}</div>` +
        `<div class="chart-tip-row"><span class="swatch" style="background: var(--series-1)"></span>Unfollowed<b>${fmt(d.u)}</b></div>` +
        `<div class="chart-tip-row"><span class="swatch" style="background: var(--series-2)"></span>Followed<b>${fmt(d.f)}</b></div>`;
      tip.classList.remove("hidden");
    });
    h.addEventListener("mousemove", (e) => {
      const w = tip.offsetWidth;
      const left = e.clientX + 14 + w > window.innerWidth ? e.clientX - 14 - w : e.clientX + 14;
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(8, e.clientY - tip.offsetHeight - 12)}px`;
    });
    h.addEventListener("mouseleave", () => {
      bandEls[i].setAttribute("fill", "transparent");
      tip.classList.add("hidden");
    });
  });
}

/* ---------------- Feeds ---------------- */

function feedHtml(items, emptyText) {
  if (!items || !items.length) return `<li class="empty">${emptyText}</li>`;
  return items.map((a) => {
    const series = a.kind === "unfollowed" ? "--series-1" : "--series-2";
    const verb = a.kind === "unfollowed" ? "Unfollowed" : "Followed";
    return `<li><span class="swatch" style="background: var(${series})"></span><span>${verb}</span>` +
      `<a class="who" href="${profileUrl(a.username)}" target="_blank" rel="noopener">@${escapeHtml(a.username)}</a>` +
      `<time datetime="${escapeHtml(a.at)}" title="${escapeHtml(new Date(a.at).toLocaleString())}">${relTime(a.at)}</time></li>`;
  }).join("");
}

export function renderFeeds() {
  const tl = state.timeline;
  $("feed").innerHTML = feedHtml(tl?.recent?.slice(0, 8), "No actions recorded yet.");
  $("grow-feed").innerHTML = feedHtml(tl?.recentFollowed, "Accounts you follow from Grow will show up here.");
}

/* ---------------- Data freshness ---------------- */

export function renderFreshness() {
  const snap = state.snapshot;
  const imp = state.importStatus;
  const ap = state.apifyStatus;
  const h = state.history;
  const row = (label, dot, value) => `<dt><span class="dot ${dot}"></span>${label}</dt><dd>${value}</dd>`;
  const stale = snap && Date.now() - new Date(snap.scannedAt).getTime() > 864e5;

  $("freshness").innerHTML = [
    row("Follower lists", !snap ? "" : stale ? "warn" : "ok",
      snap ? `<strong>${relTime(snap.scannedAt)}</strong> · ${escapeHtml(SOURCE_LABELS[snap.source] || "Scan")}` : "Not loaded"),
    row("Auto-import", imp?.enabled ? (imp.lastError ? "warn" : "ok") : "",
      imp?.enabled ? (imp.lastImportedAt ? `Last import <strong>${relTime(imp.lastImportedAt)}</strong>` : "Watching, nothing imported yet") : "Off"),
    row("Apify", ap?.enabled ? (ap.lastError ? "warn" : ap.lastSuccessAt ? "ok" : "") : "",
      ap?.enabled ? (ap.lastSuccessAt ? `Last scan <strong>${relTime(ap.lastSuccessAt)}</strong>` : "No scan yet") : "Not configured"),
    row("Action memory", h ? "ok" : "",
      h ? `<strong>${fmt(h.followed)}</strong> followed · <strong>${fmt(h.unfollowed)}</strong> unfollowed` : "—"),
  ].join("");
}

/* ---------------- Sidebar ---------------- */

export function renderSidebar() {
  const s = state.status;
  const running = !!s?.running;
  $("nav-live").classList.toggle("hidden", !running);
  const nfb = state.snapshot?.counts?.notFollowingBack;
  $("nav-count-review").textContent = typeof nfb === "number" ? fmt(nfb) : "";

  const el = $("run-mini");
  if (!s) { el.innerHTML = `<div class="run-mini-top"><span class="status-dot"></span>Connecting…</div>`; return; }
  if (running) {
    const pct = s.total > 0 ? Math.round((s.processed / s.total) * 100) : 0;
    el.innerHTML = `<div class="run-mini-top"><span class="status-dot running"></span>${JOB_LABELS[s.jobType] || "Running"}` +
      `<span class="num">${fmt(s.processed)}/${fmt(s.total)}</span></div>` +
      `<div class="progress"><div class="progress-bar" style="width: ${pct}%"></div></div>` +
      (s.lastUsername ? `<div class="run-mini-sub mono">@${escapeHtml(s.lastUsername)}</div>` : "");
  } else {
    el.innerHTML = `<div class="run-mini-top"><span class="status-dot"></span>Idle` +
      `<span class="num">${fmt(s.daily?.count ?? 0)}/${fmt(s.daily?.limit ?? 0)}</span></div>` +
      `<div class="run-mini-sub">Today's action budget</div>`;
  }
}
