# IG Unfollower

Local Instagram automation tool. **Scan** your account to fetch your followers + following, **review** non-followers, **unfollow** in batches with safe pacing, and **grow** by following random users from a target profile. UI lives at the same port as the API — single-folder deployment, no separate frontend.

---

## Quick start (Windows)

The included `run.bat` (in repo root) does everything:

```bat
run.bat
```

That will:
1. Copy your real Chrome profile into a dedicated bot profile (first run only)
2. Launch Chrome on remote-debugging port `9222`
3. Start the backend on port `4545`
4. Open `http://localhost:4545/` in the bot Chrome

If you've never opened the bot Chrome before, log into Instagram once. The session is then reused on every run. A desktop shortcut named **Instagrow** is created on first run that launches the same thing.

### Manual start (any OS)

```bash
npm install
cp .env.example .env       # then edit values
npm start                  # http://localhost:4545
```

---

## How it works

```
┌────────────────┐   HTTP    ┌──────────────────────────┐
│ Browser UI     │ ────────► │  Express  (port 4545)    │
│ (public/)      │           │   - serves /public       │
│                │ ◄──JSON── │   - REST API at /api/*   │
└────────────────┘           └────────────┬─────────────┘
                                          │ Selenium WebDriver
                                          ▼
                               ┌────────────────────────┐
                               │  Chrome (port 9222 or  │
                               │  spawned by Selenium)  │
                               └────────────┬───────────┘
                                            │  DOM scrape
                                            ▼
                                  instagram.com
```

Three ways to get follower/following lists, in order of reliability:

1. **Import from Instagram data download** *(recommended)* — official, complete, accurate. Request your data at [instagram.com/download/request/](https://www.instagram.com/download/request/) (24–48 hr turnaround), upload via the UI or drop the ZIP into a watched folder for auto-import.
2. **Live scan via DOM scrape** — opens the followers/following modal and harvests usernames as you scroll. Works on healthy sessions but Instagram throttles flagged sessions aggressively (often returning partial lists).
3. *(Removed)* IG's internal REST API (`/api/v1/friendships/<id>/followers/`) was Meta's old path — they migrated web traffic to GraphQL with rotating doc_ids in 2025, and now redirect legacy v1 friendship requests to `/`. The endpoint is no longer usable from web origins.

---

## File structure

```
.
├── package.json
├── .env.example          ← copy to .env
├── .gitignore
├── readme.md             ← this file
├── run.bat               ← Windows launcher (Chrome + backend)
├── data/                 ← cached snapshot + import state (gitignored)
│   ├── snapshot.json
│   └── import-state.json
├── public/               ← UI served at http://localhost:4545/
│   ├── index.html
│   ├── styles.css
│   ├── app.js            (boot + event wiring)
│   ├── state.js          (shared state + DOM refs)
│   ├── render.js         (state → DOM)
│   ├── api.js            (fetch wrapper + endpoint catalog)
│   ├── ig-parser.js      (IG data-download JSON parsing)
│   └── util.js           (fmt, escapeHtml, error toast)
└── src/
    ├── server.js         Express app, route registration
    ├── config.js         env parsing
    ├── state.js          in-memory job state + bounded log buffer
    ├── utils.js          sleep, randInt, normalizeUsername, shuffleAndPick
    ├── constants.js      scrape timings + dialog wait limits
    ├── persistence.js    snapshot file I/O
    ├── importer.js       auto-watcher for IG export ZIPs
    ├── selenium/
    │   ├── index.js      barrel
    │   ├── driver.js     buildDriver (remote-debugging or spawned)
    │   ├── dom.js        jsFindAndClick, jsElementExists, waitFor*
    │   ├── actions.js    login check, follow/unfollow flows, rate-limit, detectCurrentUser
    │   └── scraper.js    DOM scrape (followers/following modal harvester)
    └── jobs/
        ├── index.js      barrel
        ├── runner.js     withDriverSession (shared lifecycle wrapper)
        ├── scan.js       runScanJob
        ├── unfollow.js   runUnfollowJob
        └── follow.js     runFollowJob
```

Adding a new job is `~30 lines`: a new file in `jobs/` that calls `withDriverSession({...})`, plus a route in `server.js`.

---

## Features

| Feature | Endpoint | UI panel |
|---------|----------|----------|
| Live scan | `POST /api/scan/start` | "My account" → Scan now |
| Import data download | `POST /api/scan/upload` | "My account" → Import data download |
| Auto-import watcher status | `GET /api/import/status` | (status pill below the scan row) |
| Read latest snapshot | `GET /api/scan/latest` | (auto-loaded on page open) |
| Browse + filter lists | (client-side from snapshot) | "Browse & select" |
| Unfollow non-followers | `POST /api/unfollow/start` | "Automation" |
| Follow random users | `POST /api/follow/start` | "Grow followers" |
| Stop running job | `POST /api/job/stop` | Stop button |
| Live status / logs | `GET /api/unfollow/status` | (polled) |
| Health check | `GET /health` | — |

---

## API reference

### `POST /api/scan/start`
Live DOM scrape of the logged-in user's followers + following modals. Saves to `data/snapshot.json`.

```json
{ "ownerUsername": "manuj_rai_official" }   // optional — auto-detected if omitted
```

### `POST /api/scan/upload`
Imports follower/following usernames pre-extracted from an Instagram data download (frontend reads the JSONs via FileReader and posts here).

```json
{
  "owner": "manuj_rai_official",
  "followers": ["user1", "user2", "..."],
  "following": ["user1", "user3", "..."]
}
```

### `GET /api/import/status`
Returns the auto-import watcher state — watched folder, last imported file/owner/counts, last error.

### `GET /api/scan/latest`
Returns the cached snapshot plus the precomputed comparison.

```json
{
  "ok": true,
  "snapshot": {
    "owner": "manuj_rai_official",
    "scannedAt": "2026-05-14T05:48:39.288Z",
    "counts": {
      "followers": 4245, "following": 2244,
      "notFollowingBack": 300, "mutuals": 1944, "fans": 2301
    },
    "lists": { "notFollowingBack": ["..."], "mutuals": ["..."], "fans": ["..."] }
  }
}
```

### `POST /api/unfollow/start`
Unfollows a list of usernames with pacing + daily-limit enforcement.

```json
{
  "usernames": ["user1", "user2"],
  "minDelayMs": 15000, "maxDelayMs": 30000,
  "dailyLimit": 80, "dryRun": false
}
```

### `POST /api/follow/start`
Scrapes a source profile's followers/following list and follows N random accounts.

```json
{
  "source": { "username": "natgeo", "type": "followers" },
  "count": 30,
  "minDelayMs": 20000, "maxDelayMs": 45000,
  "dryRun": false
}
```

### `POST /api/job/stop`
Requests a graceful stop on the currently-running job (any type).

### `GET /api/unfollow/status`
Returns running flag, job type, daily counter, recent log lines.

---

## Environment variables

See `.env.example` for the full list with comments. The important ones:

| Variable | Default | Notes |
|----------|---------|-------|
| `CHROME_USER_DATA_DIR` | — | **Required.** Path to Chrome profile dir. `run.bat` sets this up automatically. |
| `CHROME_PROFILE_DIR` | `Default` | Profile name (e.g. `Profile 2`). |
| `PORT` | `4545` | Backend HTTP port (also serves UI). |
| `DAILY_LIMIT` | `80` | Hard cap on follow + unfollow actions per day. **Keep low or IG will flag you.** |
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | `15000` / `30000` | Random delay between IG actions. |
| `DRY_RUN` | `false` | Log what would happen, don't actually click. |
| `USE_REMOTE_DEBUGGING` | `true` | Attach to existing Chrome on `REMOTE_DEBUGGING_PORT` instead of spawning one. Required for `run.bat`. |
| `IG_IMPORT_DIR` | — | Folder watched for new IG data-download ZIPs. Leave blank to disable auto-import. |
| `IG_IMPORT_OWNER` | — | IG username for imported data (fallback if the ZIP doesn't include `personal_information.json`). |
| `IG_IMPORT_POLL_MS` | `30000` | How often to scan the import folder for new ZIPs. |

### Safe pacing recommendations

| Action | Daily limit | Delay |
|--------|-------------|-------|
| Unfollow | 100–150 | 8–20 s |
| Follow random | 50–80 | 20–45 s |

`DAILY_LIMIT=500` and `MIN_DELAY_MS=2000` are deep into ban territory. Don't.

---

## Auto-import (Google Drive sync)

If you set `IG_IMPORT_DIR` to a folder that receives IG export ZIPs (typically your Google Drive desktop sync target), the backend polls that folder every `IG_IMPORT_POLL_MS` milliseconds. On each new `.zip` it extracts `followers_*.json` + `following.json` from `connections/followers_and_following/` and overwrites `data/snapshot.json`. Owner is auto-recovered from `personal_information/personal_information.json` inside the ZIP. Processed ZIPs are tracked in `data/import-state.json` so they aren't re-imported.

The UI shows a status pill below the scan row: watched folder + last import time + last error if any.

---

## Troubleshooting

### ChromeDriver version mismatch
Selenium 4.27+ auto-downloads matching ChromeDriver via Selenium Manager. If you hit a version error, force a refresh:

```bash
npm run update-selenium
# Windows
rmdir /s /q "%USERPROFILE%\.cache\selenium"
# Mac/Linux
rm -rf ~/.cache/selenium
```

### "Not logged in to Instagram"
Open the bot Chrome (the one launched by `run.bat`) and log in once. The session persists in `%USERPROFILE%\ChromeBot`.

### Live scan returns far fewer followers than you actually have
Instagram throttles the followers modal aggressively for any session it has soft-flagged. Symptoms: the scrape stops at ~30 followers when you have thousands. The fix isn't more scraping — it's switching to the data-download import path, which is what Instagram themselves produce for you and is 100% complete. Request your data at [instagram.com/download/request/](https://www.instagram.com/download/request/), then either click **Import data download** in the UI or drop the ZIP into the `IG_IMPORT_DIR` folder.

### Rate-limited / "action blocked"
Stop the job. Wait 24–48 hours. Lower `DAILY_LIMIT` and raise the delays before resuming.

### Port already in use
```powershell
# find owner of port 4545
Get-NetTCPConnection -LocalPort 4545 | ForEach-Object { Get-Process -Id $_.OwningProcess }
```

---

## Architecture notes

- **One job at a time.** A `state.running` flag in `src/state.js` gates job starts. Adding a queue would be straightforward — the wrapper in `jobs/runner.js` is the natural place.
- **Daily counter is in-memory.** Resets on backend restart. Persisting it to `data/` is a planned safety improvement.
- **Snapshot is overwritten** on each scan or import. No history yet — adding versioned snapshots (`snapshot-2026-05-14.json`) would unlock a "what changed since last scan" view.
- **Auto-import skips while a job is running** so live scans/follows/unfollows don't get their snapshot clobbered mid-run.

---

## License

MIT.
