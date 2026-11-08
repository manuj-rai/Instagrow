// Username scraper for an IG profile's followers/following list.
// Two strategies: IG's internal REST API (preferred — fast, virtualization-proof)
// and a DOM/MutationObserver fallback (when the session is soft-flagged and
// the API call gets redirected to /).

const { sleep, normalizeUsername } = require("../utils");
const { state, log } = require("../state");
const {
  IG_APP_ID,
  SCRAPE_TYPES,
  DIRECT_URL_DIALOG_WAIT_MS,
  POST_DIALOG_WAIT_MS,
  SCROLL_STEP_PX,
  SCROLL_LOOP_DELAY_MS,
  STABLE_AT_BOTTOM_LIMIT,
  SCRAPE_API_PAGE_SIZE,
  SCRAPE_API_PAGE_DELAY_MS,
} = require("../constants");
const {
  jsFindAndClick,
  waitForDialog,
  waitForProfileReady,
} = require("./dom");

/* ---------------- API path ---------------- */

// Resolves a username → numeric user_id via IG's public web_profile_info
// endpoint. Also harvests the X-IG-Set-WWW-Claim response header as a
// fallback claim source if sessionStorage doesn't have one yet.
async function fetchUserIdViaApi(driver, username) {
  try {
    const result = await driver.executeAsyncScript(function (username, appId) {
      var cb = arguments[arguments.length - 1];
      fetch(
        "https://www.instagram.com/api/v1/users/web_profile_info/?username=" + encodeURIComponent(username),
        { credentials: "include", headers: { "X-IG-App-ID": appId, "X-Requested-With": "XMLHttpRequest" } }
      )
        .then(function (r) {
          var claim = r.headers.get("x-ig-set-www-claim") || r.headers.get("X-IG-Set-WWW-Claim");
          if (!r.ok) return Promise.reject(new Error("HTTP " + r.status));
          return r.json().then(function (data) { return { data: data, claim: claim }; });
        })
        .then(function (out) {
          var u = out.data && out.data.data && out.data.data.user;
          cb({ ok: true, id: u && (u.id || u.pk), username: u && u.username, claim: out.claim });
        })
        .catch(function (e) { cb({ ok: false, error: String((e && e.message) || e) }); });
    }, username, IG_APP_ID);

    if (result && result.ok && result.id) {
      return { id: String(result.id), claim: result.claim || null };
    }
    if (result && !result.ok) log(`ID lookup failed: ${result.error}`);
    return null;
  } catch (err) {
    log(`ID lookup error: ${err.message}`);
    return null;
  }
}

// Reads the real X-IG-WWW-Claim from sessionStorage (key: www-claim-v2),
// falls back to the optional header-extracted claim, then to "0".
async function readClaimFromSession(driver, headerClaim) {
  try {
    const ss = await driver.executeScript(function () {
      try { return sessionStorage.getItem("www-claim-v2"); } catch (e) { return null; }
    });
    return ss || headerClaim || "0";
  } catch {
    return headerClaim || "0";
  }
}

async function fetchListViaApi(driver, userId, sourceType, { harvestAll, targetCount, onProgress, wwwClaim }) {
  const collected = new Set();
  const seenCursors = new Set();      // cursors already walked — detects IG cursor cycles / repeats
  let maxId = "";
  let page = 0;
  let transientStreak = 0;            // consecutive same-cursor retries (HTTP error / empty page)
  let partial = false;                // true if we stopped for any reason other than a real end-of-list
  const wantedPool = harvestAll ? Infinity : Math.max(targetCount * 3, targetCount + 20);
  // Absolute backstop so a never-null / rotating cursor can't spin forever.
  // Mirrors the DOM fallback's iteration ceiling; 5000 * 200 = 1M usernames.
  const MAX_PAGES = harvestAll ? 5000 : Math.max(50, Math.ceil(wantedPool / SCRAPE_API_PAGE_SIZE) * 3);
  // Consecutive transient pages (HTTP error or empty-but-paginable) we ride out
  // — with exponential backoff — before concluding the feed is genuinely stuck.
  const MAX_TRANSIENT_STREAK = 6;

  while (true) {
    if (state.stopRequested) { log("⏹️  Stop requested during API pagination."); break; }
    if (page >= MAX_PAGES) {
      log(`⚠️  Hit page cap (${MAX_PAGES}) at ${collected.size} ${sourceType}; stopping.`);
      partial = true;
      break;
    }

    const batch = await driver.executeAsyncScript(function (userId, sourceType, maxId, appId, pageSize, wwwClaim) {
      var cb = arguments[arguments.length - 1];
      var url = "https://www.instagram.com/api/v1/friendships/" + userId + "/" + sourceType +
                "/?count=" + pageSize +
                "&search_surface=follow_list_page" +
                (maxId ? "&max_id=" + encodeURIComponent(maxId) : "");
      var csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || "";
      fetch(url, {
        credentials: "include",
        headers: {
          "X-IG-App-ID": appId,
          "X-Requested-With": "XMLHttpRequest",
          "X-ASBD-ID": "129477",
          "X-IG-WWW-Claim": wwwClaim || "0",
          "X-CSRFToken": csrf,
        },
      })
        .then(function (r) {
          return r.text().then(function (txt) {
            return {
              status: r.status, body: txt, finalUrl: r.url, redirected: r.redirected,
              ct: r.headers.get("content-type") || "",
            };
          });
        })
        .then(function (resp) {
          var diag = " | finalUrl: " + resp.finalUrl + " | redirected: " + resp.redirected + " | content-type: " + resp.ct;
          if (resp.status !== 200) {
            return cb({ ok: false, error: "HTTP " + resp.status, body: resp.body.slice(0, 200) + diag });
          }
          var parsed;
          try { parsed = JSON.parse(resp.body); }
          catch (e) { return cb({ ok: false, error: "JSON parse failed", body: resp.body.slice(0, 200) + diag }); }
          if (parsed.status && parsed.status !== "ok") {
            return cb({ ok: false, error: parsed.message || "API status: " + parsed.status });
          }
          cb({
            ok: true,
            users: (parsed.users || []).map(function (u) { return (u.username || "").toLowerCase(); }).filter(Boolean),
            next_max_id: parsed.next_max_id || null,
          });
        })
        .catch(function (e) { cb({ ok: false, error: String((e && e.message) || e) }); });
    }, userId, sourceType, maxId, IG_APP_ID, SCRAPE_API_PAGE_SIZE, wwwClaim || null);

    page += 1;

    // Transient failure (HTTP non-200 / redirect-to-"/" / JSON parse fail / status:fail).
    // A mid-pagination hiccup must NOT discard the pages already collected, and must
    // NOT be read as end-of-list — back off and retry the SAME cursor.
    if (!batch || !batch.ok) {
      const err = batch ? batch.error : "unknown";
      transientStreak += 1;
      if (transientStreak >= MAX_TRANSIENT_STREAK) {
        if (collected.size > 0) {
          log(`⚠️  API throttled (${err}); returning ${collected.size} ${sourceType} collected so far.`);
          partial = true;
          break;
        }
        // Nothing salvageable yet — let the caller fall back to the DOM scrape.
        const bodySnippet = batch && batch.body ? ` | body[0..200]: ${batch.body.replace(/\s+/g, " ")}` : "";
        throw new Error(`API page ${page} failed: ${err}${bodySnippet}`);
      }
      const backoff = Math.min(30000, SCRAPE_API_PAGE_DELAY_MS * Math.pow(2, transientStreak));
      log(`⏳ API page ${page} transient (${err}); backoff ${Math.round(backoff / 1000)}s, retry ${transientStreak}/${MAX_TRANSIENT_STREAK}...`);
      await sleep(backoff);
      continue; // retry SAME maxId
    }

    // Empty page while a cursor is still present = throttle pacing, NOT end-of-list.
    // Retry the SAME cursor with backoff rather than advancing past withheld users.
    if (batch.users.length === 0 && batch.next_max_id) {
      transientStreak += 1;
      if (transientStreak >= MAX_TRANSIENT_STREAK) {
        if (collected.size > 0) {
          log(`⚠️  ${transientStreak} empty pages (likely throttled); returning ${collected.size} ${sourceType}.`);
          partial = true;
          break;
        }
        throw new Error(`API returned ${transientStreak} empty pages with no data — likely throttled/redirected.`);
      }
      const backoff = Math.min(30000, SCRAPE_API_PAGE_DELAY_MS * Math.pow(2, transientStreak));
      log(`⏳ Empty page ${page} (cursor present); backoff ${Math.round(backoff / 1000)}s, retry ${transientStreak}/${MAX_TRANSIENT_STREAK}...`);
      await sleep(backoff);
      continue; // retry SAME maxId
    }

    // Good page with data — fold in usernames. Duplicates are EXPECTED on the ranked
    // `following` cursor (IG overlaps windows), so a page that adds 0 NEW users is NOT
    // end-of-list: we advance the cursor THROUGH it. (Breaking here on added===0 was the
    // original bug that truncated large lists to a fraction, e.g. 115 of 300+.)
    transientStreak = 0;
    for (const u of batch.users) collected.add(u);
    if (onProgress) onProgress(collected.size);

    if (collected.size >= wantedPool) break;

    // The only reliable end-of-list signal: IG stops handing back a cursor.
    if (!batch.next_max_id) break;
    // A cursor we've already walked → IG is cycling; stop to avoid an infinite loop.
    if (seenCursors.has(batch.next_max_id)) {
      log(`⚠️  Pagination cursor repeated at ${collected.size} ${sourceType}; stopping.`);
      partial = true;
      break;
    }
    seenCursors.add(batch.next_max_id);
    maxId = batch.next_max_id;
    await sleep(SCRAPE_API_PAGE_DELAY_MS);
  }

  if (partial) {
    log(`⚠️  ${sourceType} list may be incomplete (${collected.size}); if it looks short, retry later or use the data-download import.`);
  }
  return Array.from(collected);
}

/* ---------------- DOM scrape (fallback) ---------------- */

async function openSourceModal(driver, cleanSource, sourceType, baseUrl, elementTimeoutMs) {
  await driver.get(`${baseUrl}/${cleanSource}/${sourceType}/`);
  let dialogOpen = await waitForDialog(driver, DIRECT_URL_DIALOG_WAIT_MS);

  if (!dialogOpen) {
    log(`Direct URL didn't open dialog, falling back to profile + click...`);
    await driver.get(`${baseUrl}/${cleanSource}/`);

    const profileStatus = await waitForProfileReady(driver, elementTimeoutMs);
    if (!profileStatus.ready) {
      throw new Error(`Source profile not ready: ${profileStatus.error || "timeout"}`);
    }
    await sleep(1200);

    const linkXpaths = sourceType === "followers"
      ? [
          `//header//a[contains(@href, '/followers')]`,
          `//a[contains(@href, '/${cleanSource}/followers')]`,
          `//a[contains(@href, '/followers/')]`,
          `//a[contains(@href, 'followers')]`,
          `//header//*[@role='link'][contains(., 'followers')]`,
          `//header//li[.//*[contains(., 'followers')]]//a[1]`,
        ]
      : [
          `//header//a[contains(@href, '/following')]`,
          `//a[contains(@href, '/${cleanSource}/following')]`,
          `//a[contains(@href, '/following/')]`,
          `//a[contains(@href, 'following')]`,
          `//header//*[@role='link'][contains(., 'following')]`,
          `//header//li[.//*[contains(., 'following')]]//a[1]`,
        ];

    const opened = await jsFindAndClick(driver, linkXpaths, elementTimeoutMs);
    if (opened.found) dialogOpen = await waitForDialog(driver, elementTimeoutMs);
  }

  if (!dialogOpen) {
    const diag = await driver.executeScript(function () {
      return {
        url: location.href,
        links: Array.from(
          document.querySelectorAll('header a, a[href*="follow"]')
        ).slice(0, 8).map((a) => ({
          href: a.getAttribute("href"),
          text: (a.textContent || "").trim().slice(0, 40),
        })),
        bodyHints: (document.body?.innerText || "").slice(0, 200),
      };
    }).catch(() => null);
    log(`Diagnostic: ${JSON.stringify(diag)}`);
    throw new Error(
      `Could not open ${sourceType} modal — private account you don't follow, or login expired.`
    );
  }
}

async function scrapeViaDom(driver, cleanSource, sourceType, { harvestAll, targetCount }) {
  log(`✓ ${sourceType} modal open. Installing harvester...`);
  await sleep(POST_DIALOG_WAIT_MS);

  await driver.executeScript(function () {
    if (window.__igScrape && window.__igScrape.observer) {
      try { window.__igScrape.observer.disconnect(); } catch {}
    }
    var dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) { window.__igScrape = { ready: false, error: "no dialog" }; return; }

    var SKIP = { p:1, reel:1, reels:1, explore:1, accounts:1, direct:1, stories:1, tv:1 };
    var collected = new Set();

    function harvest(root) {
      try {
        var links = (root || dialog).querySelectorAll('a[href^="/"]');
        for (var i = 0; i < links.length; i++) {
          var href = links[i].getAttribute("href") || "";
          var m = href.match(/^\/([^\/?#]+)\/?$/);
          if (!m) continue;
          var u = m[1].toLowerCase();
          if (SKIP[u]) continue;
          collected.add(u);
        }
      } catch (e) {}
    }
    harvest();

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) harvest(added[j]);
        }
      }
    });
    observer.observe(dialog, { childList: true, subtree: true });

    function findScrollable() {
      // Prefer the scrollable that contains the most user-profile anchors —
      // the dialog usually has an outer chrome scrollable AND an inner list
      // scrollable, and we want the inner one (where new rows actually load).
      var best = null;
      var bestRowCount = -1;
      var cands = dialog.querySelectorAll("div");
      for (var k = 0; k < cands.length; k++) {
        var s = window.getComputedStyle(cands[k]);
        if ((s.overflowY === "auto" || s.overflowY === "scroll") &&
            cands[k].scrollHeight > cands[k].clientHeight) {
          var rows = cands[k].querySelectorAll('a[href^="/"]').length;
          if (rows > bestRowCount) {
            best = cands[k];
            bestRowCount = rows;
          }
        }
      }
      return best;
    }
    window.__igScrape = {
      ready: true,
      collected: collected,
      observer: observer,
      dialog: dialog,
      scrollable: findScrollable(),
      findScrollable: findScrollable,
      harvest: harvest,
    };
  });

  const wantedPool = harvestAll
    ? Infinity
    : Math.max(targetCount * 3, targetCount + 20);
  const maxIterations = harvestAll ? 5000 : 200;
  let lastSize = 0;
  let stableAtBottom = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (state.stopRequested) {
      log("⏹️  Stop requested during scrape.");
      break;
    }

    let step;
    try {
      step = await driver.executeScript(function (stepPx) {
        var s = window.__igScrape;
        if (!s || !s.ready) return { count: 0, atBottom: true, error: "not-ready" };
        try { s.harvest(s.dialog); } catch (e) {}
        // Re-detect scrollable each tick — initial pick may have been wrong, or
        // the list container may have been replaced as IG re-renders.
        var newSc = s.findScrollable();
        if (newSc && newSc !== s.scrollable) s.scrollable = newSc;
        var sc = s.scrollable;
        if (!sc) return { count: s.collected.size, atBottom: true, error: "no-scrollable" };
        var prevTop = sc.scrollTop;
        sc.scrollTop = sc.scrollTop + stepPx;
        // Fire real scroll + wheel events so IG's React lazy-loader (which may
        // listen for these rather than just polling scrollTop) actually fires.
        try {
          sc.dispatchEvent(new Event("scroll", { bubbles: true }));
          sc.dispatchEvent(new WheelEvent("wheel", { deltaY: stepPx, bubbles: true, cancelable: true }));
        } catch (e) {}
        var atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 8;
        return { count: s.collected.size, moved: sc.scrollTop !== prevTop, atBottom: atBottom };
      }, SCROLL_STEP_PX);
    } catch (e) {
      // Page can transition mid-script (rare). Treat as a single skipped tick.
      step = { count: lastSize, atBottom: false };
    }
    if (!step) step = { count: lastSize, atBottom: false };

    if (step.error === "not-ready") { log("Harvester not ready, aborting."); break; }

    if (step.count !== lastSize) {
      const prev = lastSize;
      lastSize = step.count;
      stableAtBottom = 0;
      if (harvestAll) state.lastMessage = `Scraping ${sourceType}: ${step.count} harvested...`;
      // Periodic log every 50 new usernames so the user sees progress.
      if (Math.floor(step.count / 50) > Math.floor(prev / 50)) {
        log(`  ${sourceType}: ${step.count} harvested so far...`);
      }
    } else if (step.atBottom) {
      stableAtBottom += 1;
      // After half the patience budget with no new rows, try a "kick":
      // scroll up a bit then back down. Some virtualized lists need this
      // to re-trigger the lazy-load IntersectionObserver.
      if (stableAtBottom === Math.floor(STABLE_AT_BOTTOM_LIMIT / 2)) {
        await driver.executeScript(function () {
          var s = window.__igScrape;
          if (!s || !s.scrollable) return;
          var sc = s.scrollable;
          var prev = sc.scrollTop;
          sc.scrollTop = Math.max(0, prev - 400);
          sc.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await sleep(300);
      }
      if (stableAtBottom >= STABLE_AT_BOTTOM_LIMIT) break;
    }

    if (step.count >= wantedPool) break;
    await sleep(SCROLL_LOOP_DELAY_MS);
  }

  const finalList = await driver.executeScript(function () {
    var s = window.__igScrape;
    if (!s || !s.ready) return { list: [], diag: { ready: false } };
    try { s.observer.disconnect(); } catch {}
    var diag = null;
    if (s.collected.size === 0) {
      var d = s.dialog;
      diag = {
        dialogText: ((d && d.innerText) || "").slice(0, 300).replace(/\s+/g, " "),
        anchorCount: d ? d.querySelectorAll('a[href^="/"]').length : 0,
        firstHrefs: d
          ? Array.from(d.querySelectorAll('a[href^="/"]')).slice(0, 6).map(function (a) { return a.getAttribute("href"); })
          : [],
        scrollableFound: !!s.scrollable,
      };
    }
    var arr = Array.from(s.collected);
    delete window.__igScrape;
    return { list: arr, diag: diag };
  });

  if (finalList.diag) {
    log(`⚠️  DOM scrape collected 0. Diagnostic: ${JSON.stringify(finalList.diag)}`);
  }
  return finalList.list;
}

/* ---------------- Public entrypoint ---------------- */

async function scrapeUsernamesFromSource(driver, opts) {
  const { sourceUsername, sourceType, targetCount, harvestAll, baseUrl, elementTimeoutMs } = opts;

  if (!SCRAPE_TYPES.has(sourceType)) {
    throw new Error(`Unsupported source type: ${sourceType}`);
  }

  const cleanSource = normalizeUsername(sourceUsername);

  // Strategy 1: IG's internal REST API (much faster, immune to virtualization).
  // We navigate to the target profile first so the request originates from
  // there (IG ties session/claim authorization to the originating page).
  // Longer settle time matters — IG's gateway treats "just navigated then
  // immediately hit /api/v1/friendships/..." as bot-like and redirects to /.
  try {
    await driver.get(`${baseUrl}/${cleanSource}/`);
    await sleep(4500);
    log(`🌐 Resolving @${cleanSource} → user_id via API...`);
    const idResult = await fetchUserIdViaApi(driver, cleanSource);
    if (idResult && idResult.id) {
      const userId = idResult.id;
      const wwwClaim = await readClaimFromSession(driver, idResult.claim);
      log(`✓ user_id=${userId}. Paginating ${sourceType} via API...`);
      log(`  www-claim: ${wwwClaim && wwwClaim !== "0" ? wwwClaim.slice(0, 24) + "..." : "(using sentinel 0)"}`);
      const list = await fetchListViaApi(driver, userId, sourceType, {
        harvestAll, targetCount, wwwClaim,
        onProgress: (n) => { state.lastMessage = `Scraping ${sourceType} via API: ${n} so far...`; },
      });
      const set = new Set(list);
      set.delete(cleanSource);
      log(`✓ API scrape complete: ${set.size} usernames from @${cleanSource}/${sourceType}`);
      return Array.from(set);
    }
    log(`API path unavailable (no user_id), falling back to DOM scrape...`);
  } catch (apiErr) {
    log(`API path failed (${apiErr.message}), falling back to DOM scrape...`);
  }

  // Strategy 2: DOM scrape with MutationObserver.
  log(`🔎 Opening @${cleanSource}/${sourceType}...`);
  await openSourceModal(driver, cleanSource, sourceType, baseUrl, elementTimeoutMs);
  const list = await scrapeViaDom(driver, cleanSource, sourceType, { harvestAll, targetCount });

  const result = new Set(list);
  result.delete(cleanSource);
  log(`✓ Scraped ${result.size} usernames from @${cleanSource}/${sourceType}`);
  return Array.from(result);
}

module.exports = { scrapeUsernamesFromSource };
