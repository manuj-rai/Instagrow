// Username scraper for an IG profile's followers/following list.
// Two strategies: IG's internal REST API (preferred — fast, virtualization-proof)
// and a DOM/MutationObserver fallback (when API path isn't available).

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

async function fetchUserIdViaApi(driver, username) {
  try {
    const result = await driver.executeAsyncScript(function (username, appId) {
      var callback = arguments[arguments.length - 1];
      fetch(
        "https://www.instagram.com/api/v1/users/web_profile_info/?username=" +
          encodeURIComponent(username),
        {
          credentials: "include",
          headers: {
            "X-IG-App-ID": appId,
            "X-Requested-With": "XMLHttpRequest",
          },
        }
      )
        .then(function (r) {
          return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status));
        })
        .then(function (data) {
          var u = data && data.data && data.data.user;
          callback({ ok: true, id: u && (u.id || u.pk), username: u && u.username });
        })
        .catch(function (e) {
          callback({ ok: false, error: String((e && e.message) || e) });
        });
    }, username, IG_APP_ID);

    if (result && result.ok && result.id) return String(result.id);
    if (result && !result.ok) log(`ID lookup failed: ${result.error}`);
    return null;
  } catch (err) {
    log(`ID lookup error: ${err.message}`);
    return null;
  }
}

async function fetchListViaApi(driver, userId, sourceType, { harvestAll, targetCount, onProgress }) {
  const collected = new Set();
  let maxId = "";
  let page = 0;
  const wantedPool = harvestAll
    ? Infinity
    : Math.max(targetCount * 3, targetCount + 20);

  while (true) {
    if (state.stopRequested) {
      log("⏹️  Stop requested during API pagination.");
      break;
    }

    const batch = await driver.executeAsyncScript(function (userId, sourceType, maxId, appId, pageSize) {
      var callback = arguments[arguments.length - 1];
      var url = "https://www.instagram.com/api/v1/friendships/" + userId + "/" + sourceType +
                "/?count=" + pageSize +
                (maxId ? "&max_id=" + encodeURIComponent(maxId) : "");
      fetch(url, {
        credentials: "include",
        headers: {
          "X-IG-App-ID": appId,
          "X-Requested-With": "XMLHttpRequest",
        },
      })
        .then(function (r) { return r.text().then(function (txt) { return { status: r.status, body: txt }; }); })
        .then(function (resp) {
          if (resp.status !== 200) {
            return callback({ ok: false, status: resp.status, error: "HTTP " + resp.status, body: resp.body.slice(0, 200) });
          }
          var parsed;
          try { parsed = JSON.parse(resp.body); }
          catch (e) { return callback({ ok: false, error: "JSON parse failed", body: resp.body.slice(0, 200) }); }
          if (parsed.status && parsed.status !== "ok") {
            return callback({ ok: false, error: parsed.message || "API status: " + parsed.status });
          }
          callback({
            ok: true,
            users: (parsed.users || []).map(function (u) { return (u.username || "").toLowerCase(); }).filter(Boolean),
            next_max_id: parsed.next_max_id || null,
          });
        })
        .catch(function (e) { callback({ ok: false, error: String((e && e.message) || e) }); });
    }, userId, sourceType, maxId, IG_APP_ID, SCRAPE_API_PAGE_SIZE);

    if (!batch || !batch.ok) {
      const err = batch ? batch.error : "unknown";
      throw new Error(`API page ${page + 1} failed: ${err}`);
    }

    let added = 0;
    for (const u of batch.users) {
      if (!collected.has(u)) { collected.add(u); added += 1; }
    }
    page += 1;
    if (onProgress) onProgress(collected.size);

    if (collected.size >= wantedPool) break;
    if (!batch.next_max_id || added === 0) break;

    maxId = batch.next_max_id;
    await sleep(SCRAPE_API_PAGE_DELAY_MS);
  }

  return Array.from(collected);
}

/* ---------------- DOM-scrape fallback ---------------- */

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

    var scrollable = null;
    var candidates = dialog.querySelectorAll("div");
    for (var k = 0; k < candidates.length; k++) {
      var s = window.getComputedStyle(candidates[k]);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") &&
          candidates[k].scrollHeight > candidates[k].clientHeight) {
        scrollable = candidates[k];
        break;
      }
    }
    window.__igScrape = { ready: true, collected: collected, observer: observer, scrollable: scrollable };
  });

  const wantedPool = harvestAll
    ? Infinity
    : Math.max(targetCount * 3, targetCount + 20);
  const maxIterations = harvestAll ? 800 : 80;
  let lastSize = 0;
  let stableAtBottom = 0;

  for (let i = 0; i < maxIterations; i++) {
    if (state.stopRequested) {
      log("⏹️  Stop requested during scrape.");
      break;
    }

    const step = await driver.executeScript(function (stepPx) {
      var s = window.__igScrape;
      if (!s || !s.ready) return { count: 0, atBottom: true, error: "not-ready" };
      var sc = s.scrollable;
      if (!sc) return { count: s.collected.size, atBottom: true, error: "no-scrollable" };
      var prevTop = sc.scrollTop;
      sc.scrollTop = sc.scrollTop + stepPx;
      var atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 8;
      return { count: s.collected.size, moved: sc.scrollTop !== prevTop, atBottom: atBottom };
    }, SCROLL_STEP_PX);

    if (step.error === "not-ready") { log("Harvester not ready, aborting."); break; }

    if (step.count !== lastSize) {
      lastSize = step.count;
      stableAtBottom = 0;
      if (harvestAll) state.lastMessage = `Scraping ${sourceType}: ${step.count} harvested...`;
    } else if (step.atBottom) {
      stableAtBottom += 1;
      if (stableAtBottom >= STABLE_AT_BOTTOM_LIMIT) break;
    }

    if (step.count >= wantedPool) break;
    await sleep(SCROLL_LOOP_DELAY_MS);
  }

  const finalList = await driver.executeScript(function () {
    var s = window.__igScrape;
    if (!s || !s.ready) return [];
    try { s.observer.disconnect(); } catch {}
    var arr = Array.from(s.collected);
    delete window.__igScrape;
    return arr;
  });

  return finalList;
}

/* ---------------- Public entrypoint ---------------- */

async function scrapeUsernamesFromSource(driver, opts) {
  const { sourceUsername, sourceType, targetCount, harvestAll, baseUrl, elementTimeoutMs } = opts;

  if (!SCRAPE_TYPES.has(sourceType)) {
    throw new Error(`Unsupported source type: ${sourceType}`);
  }

  const cleanSource = normalizeUsername(sourceUsername);

  // Strategy 1: IG's internal REST API (preferred).
  try {
    const url = await driver.getCurrentUrl();
    if (!/^https?:\/\/(www\.)?instagram\.com\//.test(url)) {
      await driver.get(`${baseUrl}/`);
      await sleep(800);
    }
    log(`🌐 Resolving @${cleanSource} → user_id via API...`);
    const userId = await fetchUserIdViaApi(driver, cleanSource);
    if (userId) {
      log(`✓ user_id=${userId}. Paginating ${sourceType} via API...`);
      const list = await fetchListViaApi(driver, userId, sourceType, {
        harvestAll, targetCount,
        onProgress: (n) => { state.lastMessage = `Scraping ${sourceType} via API: ${n} so far...`; },
      });
      const set = new Set(list);
      set.delete(cleanSource);
      log(`✓ API scrape complete: ${set.size} usernames from @${cleanSource}/${sourceType}`);
      return Array.from(set);
    }
    log(`API path unavailable, falling back to DOM scrape...`);
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
