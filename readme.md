# Instagrow

A local-first Instagram helper that runs on your own machine. It finds the accounts that don't follow you back, unfollows them in slow, randomized batches, and finds new accounts to follow from any public profile.

It drives **your own logged-in Chrome** through Selenium. There are no passwords to hand over and no third-party server sees your session. The web UI is served by the same small Express backend, so there's one folder and one port.

> [!WARNING]
> Automating actions on Instagram is against Instagram's [Terms of Use](https://help.instagram.com/581066165581870). Too many follows or unfollows too fast can get your account rate-limited, action-blocked or banned. This project is for personal and educational use. Keep the limits low, and use it at your own risk.

---

## Features

- **Get your followers and following lists**, three ways (see [Getting your lists](#getting-your-lists)):
  - import Instagram's official data download, by hand or auto-imported from a watched folder
  - a cloud scan through [Apify](#apify-scan), optionally on a schedule
  - a live scan through your browser
- **Compare the lists**: *not following back*, *mutuals* and *fans*, with search and multi-select.
- **Unfollow in batches**, with a random delay between actions and a daily cap. Stop at any time.
- **Grow**: collect the followers or following of a source profile and follow N random accounts from it.
- **Action memory**: an account you've followed or unfollowed is never targeted again (`data/history.json`). You can clear it from the UI.
- **Survives hiccups**: reconnects if Chrome restarts mid-run, and treats a slow page load as fine once the right profile is open.
- **Logs** stream live in the UI and are saved to `data/logs/YYYY-MM-DD.log`.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- Google Chrome
- Windows for the one-click `run.bat` launcher (on macOS or Linux, use the [manual start](#manual-start-any-os))
- Optional: an [Apify](https://apify.com/) account for cloud scans

---

## Quick start (Windows)

```bat
git clone https://github.com/manuj-rai/Instagrow.git
cd Instagrow
npm install
copy .env.example .env
run.bat
```

`run.bat` does the following:

1. **First run only:** copies a Chrome profile into a dedicated bot profile at `%USERPROFILE%\ChromeBot`. It copies the profile named by `CHROME_PROFILE`, which defaults to `Profile 2`. Most people's main profile is called `Default`, so set `CHROME_PROFILE` (or edit the top of `run.bat`) to the profile you're logged into Instagram with. You can find the name at `chrome://version` → *Profile Path*.
2. Launches that bot Chrome with remote debugging on port `9222`.
3. Starts the backend on port `4545` in its own window.
4. Opens the UI at `http://localhost:4545/`.

If Instagram isn't logged in inside the bot Chrome, log in there once. The session is reused on every later run.

### Manual start (any OS)

```bash
npm install
cp .env.example .env        # then edit values

# Start Chrome with a dedicated profile and the debug port, then log in to Instagram in it:
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/ChromeBot"

npm start                   # UI at http://localhost:4545
```

Alternatively, set `USE_REMOTE_DEBUGGING=false` and Selenium launches Chrome itself with `CHROME_USER_DATA_DIR` / `CHROME_PROFILE_DIR`. No other Chrome window can be using that profile at the time.

---

## Getting your lists

| Method | Complete? | Cost | Notes |
|---|---|---|---|
| **Instagram data download** *(recommended)* | ✅ Yes, it's Instagram's own export | Free | Takes 24–48 h to arrive. Can be automated with a watched folder. |
| **Apify scan** | ✅ On a paid Apify plan | Paid per result | No browser involved, can run on a schedule. Your account must be public. |
| **Live scan** | ⚠️ Often partial | Free | Uses your session. Instagram throttles it on busy or flagged accounts. |

### 1. Instagram data download

Request your data at [instagram.com/download/request](https://www.instagram.com/download/request/) and choose **JSON** format. When it arrives, either:

- click **Import data download** in the UI and select `followers_*.json` and `following.json` from `connections/followers_and_following/`, or
- set `IG_IMPORT_DIR` to a folder where exports land. Meta's *scheduled transfer to Google Drive* plus the Google Drive desktop app works well for this. The backend polls the folder and imports any new ZIP or extracted export automatically, then the UI refreshes. Processed exports are tracked in `data/import-state.json`.

### 2. Apify scan

See [Apify scan](#apify-scan) below.

### 3. Live scan

**Scan now** in the UI uses your logged-in session. It first tries Instagram's internal web API, then falls back to scrolling the followers and following lists. It works on healthy sessions, but Instagram often cuts it short on flagged ones (for example, ~30 results when you have thousands). If that happens, use the data download.

---

## Using the app

| Panel | What it does |
|---|---|
| **My account** | Scan, import, or scan through Apify. Shows the current snapshot's owner, age and counts. |
| **Results** | Followers, following, not following back, mutuals and fans counts. |
| **Browse & select** | Search the lists and tick accounts under *Not following back* to unfollow them. |
| **Automation** | **Unfollow selected**, live progress, logs, a **Stop** button, and *Action memory* (accounts that will be skipped next time). |
| **Grow followers** | Pick a source profile and *followers* or *following*, set a count, then **Discover & follow**. |

Only one job runs at a time. **Stop** ends the current job after the account it's on.

### Safe pacing

| Action | Daily limit | Delay between actions |
|---|---|---|
| Unfollow | 100–150 | 8–20 s |
| Follow | 50–80 | 20–45 s |

Going much faster (e.g. `DAILY_LIMIT=500`, `MIN_DELAY_MS=2000`) is a fast way to get action-blocked. If you see "Try again later" or "action blocked", stop and wait 24–48 hours, then resume with lower limits.

---

## Apify scan

Set `APIFY_TOKENS` in `.env` to enable the **Scan via Apify** button. You can get a token at [console.apify.com/settings/integrations](https://console.apify.com/settings/integrations).

- The scan uses the [`apify/instagram-followers-following-scraper`](https://apify.com/apify/instagram-followers-following-scraper) Actor. It starts one run for followers and one for following, in parallel, then writes `data/snapshot.json`. **Stop** aborts both runs, which also stops the billing.
- The account it scans is the username in the UI box, else `IG_IMPORT_OWNER`, else the owner of the last snapshot.
- **To run it on a schedule**, set `APIFY_SCAN_INTERVAL_HOURS` (e.g. `24` for daily, `168` for weekly).
  - The schedule survives restarts: the next run is timed from the last attempt, which is stored in `data/apify-state.json`.
  - A scan that comes due while another job is running waits for it to finish.
- **Incomplete results are held back.** The snapshot decides who shows up under *not following back*, so a truncated list would put people who do follow you up for unfollowing. A result is not saved when:
  - a list shrinks more than `APIFY_MAX_SHRINK_PCT` (default 25%) compared to the last snapshot,
  - a list hits `APIFY_RESULTS_LIMIT`, or
  - both lists come back empty.
  
  The UI then offers **Save anyway**, which saves the held-back result without paying for another run.
- **Cost:** Apify bills per result returned, from $1.15 per 1,000 on paid plans. One scan costs roughly (followers + following) results. On the **free plan** the Actor returns only the first page of each list, so full scans need a paid plan. `APIFY_MAX_CHARGE_USD` caps the spend per run. Private accounts can't be scanned.

---

## Configuration

Copy `.env.example` to `.env`. Every setting is optional except the Chrome profile settings, if Selenium launches Chrome itself.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4545` | Backend and UI port. |
| `USE_REMOTE_DEBUGGING` | `false` | When `true`, attaches to a Chrome already running on `REMOTE_DEBUGGING_PORT`. `run.bat` needs this set to `true`. |
| `REMOTE_DEBUGGING_PORT` | `9222` | |
| `CHROME_USER_DATA_DIR` | — | Chrome user-data folder, used when Selenium launches Chrome. |
| `CHROME_PROFILE_DIR` | — | Profile folder name inside it (e.g. `Default`). |
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | `15000` / `30000` | Random delay between actions. |
| `DAILY_LIMIT` | `80` | Cap on follows + unfollows per day. The count is kept in memory and resets when the backend restarts. |
| `DRY_RUN` | `false` | Log what would happen without clicking anything. |
| `PAGE_LOAD_TIMEOUT_MS` | `45000` | |
| `ELEMENT_TIMEOUT_MS` | `12000` | How long to wait for a button to appear. |
| `IG_IMPORT_DIR` | — | Folder watched for Instagram data-download exports. Leave blank to disable. |
| `IG_IMPORT_OWNER` | — | Your username, used as a fallback when an export doesn't include it. Also used by the Apify scan. |
| `IG_IMPORT_POLL_MS` | `30000` | How often the import folder is checked. |
| `APIFY_TOKENS` | — | One or more Apify tokens, comma-separated (the next one is tried if one is rejected). |
| `APIFY_SCAN_INTERVAL_HOURS` | `0` | Hours between automatic Apify scans. `0` means manual only. |
| `APIFY_RESULTS_LIMIT` | `10000` | Maximum results per list per run. |
| `APIFY_MAX_CHARGE_USD` | — | Spend cap per Actor run. |
| `APIFY_MAX_SHRINK_PCT` | `25` | Shrink threshold for the incomplete-result guard. |
| `CORS_ORIGIN` | `*` | |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn` or `error`. |

---

## API reference

All endpoints return JSON, with `ok: true` or `ok: false` plus a `message`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/config` | Effective limits and delays |
| `GET` | `/api/unfollow/status` | Running job, progress, daily counter, recent logs |
| `POST` | `/api/scan/start` | Live scan. Body: `{ "ownerUsername"?: "your_username" }` |
| `POST` | `/api/scan/upload` | Import lists. Body: `{ "owner", "followers": [], "following": [] }` |
| `GET` | `/api/scan/latest` | Snapshot, counts and the three comparison lists |
| `GET` | `/api/import/status` | Auto-import watcher state |
| `POST` | `/api/apify/scan` | Apify scan. Body: `{ "ownerUsername"?: "your_username" }` |
| `GET` | `/api/apify/status` | Last scan, schedule, held-back result |
| `POST` | `/api/apify/accept` | Save a held-back Apify result |
| `POST` | `/api/unfollow/start` | Body: `{ "usernames": [], "minDelayMs"?, "maxDelayMs"?, "dailyLimit"?, "dryRun"? }` |
| `POST` | `/api/follow/start` | Body: `{ "source": { "username", "type": "followers" \| "following" }, "count", ...same optional fields }` |
| `POST` | `/api/job/stop` | Stop whatever job is running |
| `GET` | `/api/history` | Followed / unfollowed counts |
| `POST` | `/api/history/clear` | Body: `{ "which": "all" \| "followed" \| "unfollowed" }` |

Example `GET /api/scan/latest` response:

```json
{
  "ok": true,
  "snapshot": {
    "owner": "your_username",
    "scannedAt": "2026-05-14T05:48:39.288Z",
    "counts": { "followers": 4245, "following": 2244, "notFollowingBack": 300, "mutuals": 1944, "fans": 2301 },
    "lists": { "notFollowingBack": ["..."], "mutuals": ["..."], "fans": ["..."] },
    "history": { "followed": 120, "unfollowed": 310 }
  }
}
```

---

## How it works

```
┌────────────────┐   HTTP    ┌──────────────────────────┐   Apify API   ┌─────────────┐
│ Browser UI     │ ────────► │  Express  (port 4545)    │ ────────────► │ Apify Actor │
│ (public/)      │ ◄──JSON── │  REST API + static UI    │               └─────────────┘
└────────────────┘           └────────────┬─────────────┘
                                          │ Selenium WebDriver
                                          ▼
                               ┌────────────────────────┐
                               │ Your Chrome (bot       │ ──► instagram.com
                               │ profile, port 9222)    │
                               └────────────────────────┘
```

- **One job at a time.** `state.running` in `src/state.js` guards job starts, and every Selenium job goes through `withDriverSession` in `src/jobs/runner.js`.
- **The snapshot** (`data/snapshot.json`) is replaced on each scan or import. The comparison lists are computed on request, and accounts you've already unfollowed are left out, so the lists stay accurate between scans.
- **Action memory** (`data/history.json`) records every follow and unfollow, so the same account is never targeted twice.
- Everything under `data/` (snapshot, history, logs, import and Apify state) is local and gitignored.

### Project structure

```
.
├── run.bat               Windows launcher (bot Chrome + backend + UI)
├── .env.example          copy to .env
├── public/               UI served at http://localhost:4545/
│   ├── index.html, styles.css
│   ├── app.js            boot + event wiring
│   ├── render.js         state → DOM
│   ├── state.js          shared state + DOM refs
│   ├── api.js            backend calls
│   ├── ig-parser.js      data-download JSON parsing
│   └── util.js
└── src/
    ├── server.js         Express app + routes
    ├── config.js         env parsing
    ├── state.js          job state, log buffer, daily log files
    ├── history.js        action memory (followed / unfollowed)
    ├── persistence.js    snapshot file I/O
    ├── importer.js       watched-folder auto-import
    ├── apify.js          Apify REST client
    ├── constants.js, utils.js
    ├── selenium/         driver, DOM helpers, IG actions, list scraper
    └── jobs/             runner, scan, apifyScan, unfollow, follow
```

Adding a job takes about 30 lines: a file in `src/jobs/` that calls `withDriverSession({...})`, plus a route in `server.js`.

---

## Troubleshooting

**ChromeDriver version mismatch.** Selenium Manager downloads a matching driver automatically. If it gets stuck, run `npm run update-selenium` and delete the Selenium cache: `%USERPROFILE%\.cache\selenium` on Windows, `~/.cache/selenium` elsewhere.

**"Not logged in to Instagram".** Log in once inside the bot Chrome (the one `run.bat` starts). The session lives in `%USERPROFILE%\ChromeBot`.

**"Could not connect to Chrome on port 9222".** Start Chrome through `run.bat`, or with `--remote-debugging-port=9222`, before starting the backend. Visit `http://localhost:9222/json/version` to check that it's up.

**A run stops with "Chrome connection lost".** Chrome closed or the machine restarted. The job reconnects up to 3 times and then stops instead of failing every remaining account. Accounts it didn't reach are untouched, so start the run again.

**Moving between profiles is slow.** Keep the bot Chrome window open (not minimized). If you launched it before `run.bat` added the anti-throttling flags, close the bot Chrome and run `run.bat` again so it relaunches with them.

**A live scan returns far fewer followers than you have.** Instagram is throttling the session. Use the data-download import or an Apify scan instead.

**Port already in use.**

```powershell
Get-NetTCPConnection -LocalPort 4545 | ForEach-Object { Get-Process -Id $_.OwningProcess }
```

---

## License

[MIT](LICENSE)
