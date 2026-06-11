# TotoLab Operations

The system runs itself. There is no required weekly action.

---

## Automated schedule

All times KST.

```
06:00 daily          collectFixtures        Cloud Functions     pull next 7 days of EPL fixtures
12:00 daily          worker.yml             GitHub Actions      re-analyze every match in next 24h
09:00 daily          collectResults         Cloud Functions     mark won/lost on finished matches
23:00 Sat & Sun      collectResultsSatNight Cloud Functions     pick up evening results same night
                     collectResultsSunNight
```

Worker re-analyzes the **same** match on each successive run as it
approaches kickoff (e.g., a Saturday 16:00 KST match is analyzed at
12:00 KST on Friday and again at 12:00 KST on Saturday). Each pass
fetches fresh injury data via the Claude CLI's WebSearch, fresh odds
from The Odds API, and fresh form/standings from football-data.org.

There is no `analyzed: true` skip — every match in the 24h window is
analyzed every run.

GitHub Actions cron can drift 15–30 minutes under load; for a daily
noon job that's irrelevant.

---

## Where each piece runs

| Component | Location | Notes |
|---|---|---|
| Frontend | Firebase Hosting | static SPA in `index.html` |
| Fixtures + results crons | Firebase Cloud Functions (asia-northeast3) | see `functions/index.js` |
| Telegram notifier | Firebase Cloud Functions (Firestore trigger) | fires when `recommendations/current` changes |
| Daily analysis | GitHub Actions (`.github/workflows/worker.yml`) | `ubuntu-latest`, headless Claude Code CLI |
| Deploy | GitHub Actions (`.github/workflows/deploy.yml`) | on push to `main` |

No servers. The repo is public, so Actions minutes are free and
unlimited.

---

## Verifying it ran

GitHub: [Actions → Daily analysis worker](https://github.com/kpeninsula84-ship-it/toto-lab/actions/workflows/worker.yml)
— last run should be green and < 24h old. A failed run sends a
Telegram message with a link to the logs.

In Firebase Console:

- Functions → logs for `collectFixtures`, `collectResults*`, `notifyTelegram`
- Firestore → `recommendations/current` — `updatedAt` should be < 24h old (in season)
- Firestore → `matches/{fixtureId}` — `analyzedAt` should be < 24h old for any match in the next 24h

---

## Manual triggers

Worker (skip the schedule and run now):

GitHub → Actions → **Daily analysis worker** → **Run workflow**.
The `horizon` input widens the analysis window (default 24h).

Local one-off run (needs a logged-in `claude` CLI and
`GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account JSON):

```bash
cd worker
node runOnce.js          # default 24h window
node runOnce.js 48       # one-off wider sweep
```

Result collection (Cloud Functions, requires `ADMIN_TOKEN`):

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  https://asia-northeast3-toto-lab.cloudfunctions.net/collectResultsManual
```

---

## Secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | Used by | Rotation |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | worker.yml | regenerate with `claude setup-token` if worker auth fails |
| `FIREBASE_SERVICE_ACCOUNT` | worker.yml | full SA JSON; reissue in Firebase Console → Service accounts |
| `FIREBASE_TOKEN` | deploy.yml | regenerate with `firebase login:ci` if deploy auth fails |
| `FOOTBALL_DATA_TOKEN`, `ODDS_API_KEY` | worker.yml + deploy.yml (functions/.env) | provider dashboards |
| `ADMIN_TOKEN` | deploy.yml (functions/.env) | any random hex |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | worker.yml failure alert + deploy.yml (functions/.env) | @BotFather |

`deploy.yml` recreates `functions/.env` from these secrets on every
deploy — firebase-tools bakes the file into the deployed Functions'
runtime env. Changing a Functions env value = update the secret, then
re-run the deploy workflow.

---

## Cost

| Item | Frequency | Per run | Monthly |
|---|---|---|---|
| Anthropic API | — | $0 (headless CLI under user subscription) | $0 |
| GitHub Actions | daily + deploys | $0 (public repo) | $0 |
| Firebase Functions | per cron | within free tier | ~$0 |
| Firestore | per write | within free tier | ~$0 |
| football-data.org | per call | free tier | $0 |
| The Odds API | per call | within paid tier already in use | — |

Hard cost attributable to TotoLab: $0.

---

## Troubleshooting

### Worker run failed (Telegram alert received)

Open the linked Actions run. Common causes:
- **Claude CLI auth** — `CLAUDE_CODE_OAUTH_TOKEN` expired/revoked.
  Regenerate locally with `claude setup-token`, update the secret,
  re-run the workflow.
- **Claude rate limits** — subscription cap (~45 messages / 5h on Pro).
  ~10 matches × 3 calls = 30 messages per run, normally fine; a manual
  run right after the cron can bunch up. Wait and re-run.
- `FOOTBALL_DATA_TOKEN` / `ODDS_API_KEY` expired — update the secret.
- Firestore auth — `FIREBASE_SERVICE_ACCOUNT` key revoked. Reissue.

### Analysis succeeded but no value picks shown on the site

Picks are surfaced only when `edgeFair >= 5%` AND `confidence >= 50`
(strong) or `confidence >= 40` (secondary). It's normal for a slate to
produce zero picks; the site shows match cards regardless.

### `collectFixtures` or `collectResults` cron didn't run

- Firebase Console → Functions → logs. Cloud Scheduler retries on
  failure within the same window.
- football-data.org occasionally returns 429; the wrapper sleeps and
  retries automatically. Persistent 429 means token issue.

### Deploy failed

GitHub Actions → latest `Deploy toto-lab` run on `main`. Usually:
- `FIREBASE_TOKEN` invalid → `firebase login:ci` locally, update secret.
- functions `npm ci` failure → lockfile drift; run `npm install` in
  `functions/` locally and commit the lockfile.

---

## Season end

Nothing to do. After the final round:
- `matches` collection stays as-is (historical data).
- `collectFixtures` will start populating new-season fixtures
  automatically when football-data.org publishes them.
- `recommendations/current` stays on the last picks until the next
  worker run finds new analyzed matches. (Known stale-display issue —
  fix scheduled in the off-season 2026 rebuild.)
