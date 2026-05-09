# IG Unfollower

Local Instagram automation tool. **Scan** your account to fetch your followers + following directly from IG, **review** non-followers, **unfollow** in batches with safe pacing, and **grow** by following random users from a target profile. UI lives at the same port as the API — single-folder deployment, no separate frontend.

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

If you've never opened the bot Chrome before, log into Instagram once. The session is then reused on every run.

### Manual start (any OS)

```bash
cd Backend
npm install
cp .env.example .env       # then edit values
npm start                  # http://localhost:4545
```

---

## How it works

```
┌────────────────┐   HTTP    ┌──────────────────────────┐
│ Browser UI     │ ────────► │  Express  (port 4545)    │
│ (Backend/      │           │   - serves /public       │
│   public/)     │ ◄──JSON── │   - REST API at /api/*   │
└────────────────┘           └────────────┬─────────────┘
                                          │ Selenium WebDriver
                                          ▼
                               ┌────────────────────────┐
                               │  Chrome (port 9222 or  │
                               │  spawned by Selenium)  │
                               └────────────┬───────────┘
                                            │  IG REST API + DOM
                                            ▼
                                  instagram.com
```

The scraper uses Instagram's own internal REST API (`/api/v1/friendships/<id>/followers/`) when possible — much faster and more reliable than scrolling the followers modal. Falls back to a `MutationObserver`-based DOM scrape if the API call is blocked.

---

## File structure

```
Backend/
├── package.json
├── dockerfile
├── .env.example          ← copy to .env
├── .gitignore  .dockerignore
├── readme.md             ← this file
├── data/                 ← cached scan snapshot (gitignored)
│   └── snapshot.json
├── public/               ← UI served at http://localhost:4545/
│   ├── index.html
│   ├── styles.css
│   ├── app.js            (boot + event wiring)
│   ├── state.js          (shared state + DOM refs)
│   ├── render.js         (state → DOM)
│   ├── api.js            (fetch wrapper + endpoint catalog)
│   └── util.js           (fmt, escapeHtml, error toast)
└── src/
    ├── server.js         Express app, route registration
    ├── config.js         env parsing
    ├── state.js          in-memory job state + bounded log buffer
    ├── utils.js          sleep, randInt, normalizeUsername, shuffleAndPick
    ├── constants.js      IG_APP_ID, page sizes, timeouts (one place to tune)
    ├── persistence.js    snapshot file I/O
    ├── selenium/
    │   ├── index.js      barrel
    │   ├── driver.js     buildDriver (remote-debugging or spawned)
    │   ├── dom.js        jsFindAndClick, jsElementExists, waitFor*
    │   ├── actions.js    login check, follow/unfollow flows, rate-limit, detectCurrentUser
    │   └── scraper.js    API-first + DOM fallback; scrapeUsernamesFromSource
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
| Scan logged-in account | `POST /api/scan/start` | "My account" |
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
Scrapes the logged-in user's full followers + following lists via IG's internal API. Saves to `data/snapshot.json`.

```json
{ "ownerUsername": "manuj_rai_official" }   // optional — auto-detected if omitted
```

### `GET /api/scan/latest`
Returns the cached snapshot plus the precomputed comparison.

```json
{
  "ok": true,
  "snapshot": {
    "owner": "manuj_rai_official",
    "scannedAt": "2026-05-09T09:58:21.706Z",
    "counts": {
      "followers": 4124, "following": 1766,
      "notFollowingBack": 200, "mutuals": 1566, "fans": 2558
    },
    "lists": { "notFollowingBack": [...], "mutuals": [...], "fans": [...] }
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

### Safe pacing recommendations

| Action | Daily limit | Delay |
|--------|-------------|-------|
| Unfollow | 100–150 | 8–20 s |
| Follow random | 50–80 | 20–45 s |

`DAILY_LIMIT=500` and `MIN_DELAY_MS=2000` are deep into ban territory. Don't.

---

## Docker deployment

The included `dockerfile` ships Chrome inside the container so Selenium runs without an external browser.

```bash
cd Backend
docker build -t ig-unfollower .
docker run -d \
  -p 4545:4545 \
  -v ig-data:/app/data \
  -e DAILY_LIMIT=80 \
  -e MIN_DELAY_MS=20000 \
  -e MAX_DELAY_MS=45000 \
  --name ig \
  ig-unfollower
```

`USE_REMOTE_DEBUGGING` is forced to `false` in the image (the container runs its own Chrome). The first run will require a manual login since there's no profile mounted; mount your bot Chrome profile as a volume to persist sessions:

```bash
-v /path/to/ChromeBot:/home/appuser/.config/google-chrome
```

For local Windows usage, prefer `run.bat` — it's faster and reuses your real Chrome login.

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

### Scan stops at ~235 / `Could not open followers modal`
This was an old DOM-virtualization issue — the API path now handles it. If you're still seeing it, the API call may be blocked; check the backend log for `API path failed (...), falling back to DOM scrape...` and inspect the diagnostic line.

### Rate-limited
Stop the job. Wait 24–48 hours. Lower `DAILY_LIMIT` and raise the delays before resuming.

### Port already in use
```powershell
# find owner of port 4545
Get-NetTCPConnection -LocalPort 4545 | ForEach-Object { Get-Process -Id $_.OwningProcess }
```

---

## Architecture notes

- **One job at a time.** A simple `state.running` flag in `src/state.js` gates job starts. Adding a queue would be straightforward — the wrapper in `jobs/runner.js` is the natural place.
- **Daily counter is in-memory.** Resets on backend restart. Persisting it to `data/` is a planned safety improvement.
- **Snapshot is overwritten** on each scan. No history yet — adding versioned snapshots (`snapshot-2026-05-09.json`) would unlock a "what changed since last scan" view.
- **No queue, no scheduler, no auth.** This is a personal local tool — designed to run on your machine, called by your browser.

---

## License

MIT.
