// Username scraper for an IG profile's followers/following list.
// DOM/MutationObserver based — IG retired the /api/v1/friendships/<id>/followers/
// endpoint for web origins and moved everything to POST /graphql/query with
// rotating doc_ids, so the legacy API path is no longer viable.

const { sleep, normalizeUsername } = require("../utils");
const { state, log } = require("../state");
const {
  SCRAPE_TYPES,
  DIRECT_URL_DIALOG_WAIT_MS,
  POST_DIALOG_WAIT_MS,
  SCROLL_STEP_PX,
  SCROLL_LOOP_DELAY_MS,
  STABLE_AT_BOTTOM_LIMIT,
} = require("../constants");
const {
  jsFindAndClick,
  waitForDialog,
  waitForProfileReady,
} = require("./dom");

/* ---------------- DOM scrape ---------------- */

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

  log(`🔎 Opening @${cleanSource}/${sourceType}...`);
  await openSourceModal(driver, cleanSource, sourceType, baseUrl, elementTimeoutMs);
  const list = await scrapeViaDom(driver, cleanSource, sourceType, { harvestAll, targetCount });

  const result = new Set(list);
  result.delete(cleanSource);
  log(`✓ Scraped ${result.size} usernames from @${cleanSource}/${sourceType}`);
  return Array.from(result);
}

module.exports = { scrapeUsernamesFromSource };
