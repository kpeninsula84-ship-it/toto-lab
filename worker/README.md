# TotoLab Analysis Worker

Standalone analysis pipeline that runs on Mac/NAS instead of Firebase Functions.
Uses the [ai-debate](https://github.com/.../ai-debate) bridge to call Claude
Code CLI under the user's subscription, costing **zero** in Anthropic API
spend.

## What it replaces

| Previously (Firebase Functions) | Now (worker) |
|---|---|
| `collectFixtures` cron | `node runOnce.js fixtures` |
| `analyzeWeekday` / `analyzeSaturday` cron | `node runOnce.js analyze` |
| `collectResults` cron | `node runOnce.js results` |
| `analyzer.js` (Anthropic SDK) | `worker/analyzer.js` (ai-debate bridge) |
| Manual injury PDF upload (weekly) | Live `web_search` per match |

`functions/` retains only `notifyTelegram` (Firestore trigger) and the public
`api` health endpoint.

## Prerequisites

1. **ai-debate server running** on `http://localhost:3000` (or set
   `AI_DEBATE_URL`).
2. **Tokens** in `/Users/dw/Projects/toto-lab/functions/.env` (or pass
   `WORKER_ENV_PATH`):
   - `FOOTBALL_DATA_TOKEN`
   - `ODDS_API_KEY`
3. **Firebase Admin credentials** — pick one:
   - `service-account.json` next to this README (download from Firebase
     Console → Project Settings → Service Accounts), OR
   - `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`, OR
   - `gcloud auth application-default login`
4. `npm install` inside `worker/` (only `firebase-admin`).

## Commands

```bash
cd worker

# Pull next 7 days of EPL fixtures into Firestore
node runOnce.js fixtures

# Analyze unanalyzed matches in the next 48h window
node runOnce.js analyze 48

# Mark won/lost on finished matches
node runOnce.js results

# Full sweep: fixtures → analyze → results
node runOnce.js full 48

# Validation script (does NOT touch Firestore)
node analyze-saturday.mjs
WORKER_ONLY="Bournemouth,Aston Villa" node analyze-saturday.mjs
```

## Scheduling on Mac (launchd)

Two plist files are checked into `worker/launchd/`:

| Plist | Purpose | When |
|---|---|---|
| `app.aidebate.server.plist` | Keep ai-debate server running on port 3000 | Always (boot + restart-on-crash) |
| `app.totolab.analyze.plist` | Run worker pipeline | Daily 13:00 KST |

The worker plist invokes `worker/run-scheduled.sh`, a wrapper that:
1. `git pull origin main` (so code pushed from any PC is picked up)
2. `npm install` if needed
3. `node runOnce.js full 48`

Install on this Mac:

```bash
# Copy plists into LaunchAgents
cp worker/launchd/app.aidebate.server.plist ~/Library/LaunchAgents/
cp worker/launchd/app.totolab.analyze.plist ~/Library/LaunchAgents/

# Load them with launchctl
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.aidebate.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.totolab.analyze.plist

# Verify
launchctl print gui/$(id -u)/app.totolab.analyze | head -5
```

Tail logs:
```bash
tail -f /tmp/totolab-worker.log
tail -f /tmp/aidebate-server.log
```

Manual run (without waiting for schedule):
```bash
launchctl kickstart -k gui/$(id -u)/app.totolab.analyze
```

Uninstall:
```bash
launchctl bootout gui/$(id -u)/app.totolab.analyze
launchctl bootout gui/$(id -u)/app.aidebate.server
rm ~/Library/LaunchAgents/app.totolab.analyze.plist
rm ~/Library/LaunchAgents/app.aidebate.server.plist
```

**Mac sleep behavior**: launchd does NOT replay missed `StartCalendarInterval`
runs. If the Mac is asleep at 13:00 KST, that day's analysis is missed. Either
keep the Mac awake during the analysis window or use `pmset schedule wake`.

## Scheduling on NAS (cron)

```cron
0 12 * * * cd /volume1/toto-lab/worker && /usr/local/bin/node runOnce.js full 48 >> /var/log/totolab-worker.log 2>&1
```

## Architecture

```
Mac/NAS
├── ai-debate (localhost:3000)
│   └── spawns claude CLI under user subscription
└── worker
    ├── runOnce.js         (entry)
    ├── pipeline.js        (collectFixtures/analyze/results/save)
    ├── analyzer.js        (ai-debate bridge call)
    └── firestore.js       (Firebase Admin push)
        ↓
    Firestore (toto-lab project)
        ↓
    Firebase Functions
        ├── notifyTelegram (onDocumentWritten recommendations/current)
        └── api (health)
        ↓
    Hosting (toto-lab.web.app)
```

## Cost

| Component | Cost |
|---|---|
| Anthropic API | $0 (CLI uses user subscription) |
| football-data.org | $0 (free tier) |
| The Odds API | within existing plan |
| Firebase Functions | minimal (read trigger only) |
| Firestore | minimal (writes per analysis) |
| Mac/NAS electricity | negligible |

## Migration phases (current status)

- [x] **Phase 0**: ai-debate `/api/analyze` endpoint exists and works
- [x] **Phase 1**: worker code parity with Functions, validation on Saturday matches
- [ ] **Phase 2**: Firebase Admin auth set up locally; first push to Firestore
- [ ] **Phase 3**: launchd schedule; run alongside Functions cron for 1-2 weeks
- [ ] **Phase 4**: disable Functions cron (`analyzeWeekday`/`analyzeSaturday`/`collectFixtures`/`collectResults*`)
- [ ] **Phase 5**: move worker to NAS once hardware is verified

## Known limitations

- `node --watch` on ai-debate server can interrupt in-flight `claude` spawns
  if a route file is edited mid-run. Use stable build for production.
- Mac sleep state pauses launchd jobs; either keep awake during analysis
  windows (`pmset`) or schedule to a time the Mac is reliably on.
- The Odds API team-totals market sometimes returns 422 (plan-dependent);
  worker degrades gracefully and uses the standard totals market only.
