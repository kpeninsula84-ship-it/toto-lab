# TotoLab Operations

The system runs itself. There is no required weekly action.

---

## Automated schedule

All times KST.

```
06:00 daily          collectFixtures        Cloud Functions     pull next 7 days of EPL fixtures
12:00 daily          totolab-worker.timer   VPS systemd         re-analyze every match in next 24h
09:00 daily          collectResults         Cloud Functions     mark won/lost on finished matches
23:00 Sat & Sun      collectResultsSatNight Cloud Functions     pick up evening results same night
                     collectResultsSunNight
```

Worker re-analyzes the **same** match on each successive run as it
approaches kickoff (e.g., a Saturday 16:00 KST match is analyzed at
12:00 KST on Friday and again at 12:00 KST on Saturday). Each pass
fetches fresh injury data via WebSearch through the ai-debate bridge,
fresh odds from The Odds API, and fresh form/standings from
football-data.org.

There is no `analyzed: true` skip — every match in the 24h window is
analyzed every run.

---

## Where each piece runs

| Component | Location | Notes |
|---|---|---|
| Frontend | Firebase Hosting | static SPA in `index.html` |
| Fixtures + results crons | Firebase Cloud Functions (asia-northeast3) | see `functions/index.js` |
| Telegram notifier | Firebase Cloud Functions (Firestore trigger) | fires when `recommendations/current` changes |
| Daily analysis | Contabo VPS via systemd timer | see `infra/systemd/totolab-worker.timer` |
| AI bridge | Same VPS, `localhost:3000` | ai-debate spawns Claude Code CLI |

---

## Verifying it ran

On the VPS:

```bash
# next firing
systemctl list-timers | grep -i totolab

# last run summary
systemctl status totolab-worker.service

# last run logs
journalctl -u totolab-worker.service -n 100 --no-pager
```

In Firebase Console:

- Functions → logs for `collectFixtures`, `collectResults*`, `notifyTelegram`
- Firestore → `recommendations/current` — `updatedAt` should be < 24h old
- Firestore → `matches/{fixtureId}` — `analyzedAt` should be < 24h old for any match in the next 24h

---

## Manual triggers

Worker (skip the schedule and run now):

```bash
# on the VPS
sudo systemctl start totolab-worker.service
journalctl -u totolab-worker.service -f
```

Wider analysis window for a one-off (e.g., re-analyze 48h):

```bash
cd /root/toto-lab/worker
sudo node runOnce.js 48
```

Result collection (Cloud Functions, requires `ADMIN_TOKEN`):

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" \
  https://asia-northeast3-toto-lab.cloudfunctions.net/collectResultsManual
```

---

## Cost

| Item | Frequency | Per run | Monthly |
|---|---|---|---|
| Anthropic API | — | $0 (ai-debate spawns CLI under user subscription) | $0 |
| Firebase Functions | per cron | within free tier | ~$0 |
| Firestore | per write | within free tier | ~$0 |
| football-data.org | per call | free tier | $0 |
| The Odds API | per call | within paid tier already in use | — |
| Contabo VPS | always-on | shared with ai-debate / my-life-os | ~$5/mo total |

Hard cost attributable to TotoLab: roughly the share of the VPS bill,
under $5/month.

---

## Troubleshooting

### Recommendations not refreshing

Check the worker:

```bash
systemctl status totolab-worker.service
journalctl -u totolab-worker.service -n 200 --no-pager
```

Common causes:
- `ai-debate.service` not running → `systemctl status ai-debate`. It has
  `Restart=always`, so a long downtime usually means a config error.
- ai-debate hitting Claude Code rate limits (HTTP 429 in the logs). Pro
  cap is ~45 messages per 5h. ~10 matches × 3 calls/match = 30 messages
  per run, comfortably under the cap, but two runs back-to-back can
  bunch up.
- `FOOTBALL_DATA_TOKEN` or `ODDS_API_KEY` expired in `worker/.env`.

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

GitHub Actions → latest workflow run on `main`. The deploy runs on a
self-hosted runner on the VPS, so failures are usually:
- VPS git pull conflict (manual `git status` on VPS)
- `firebase deploy` auth (check `/root/.firebase_token` exists and is
  valid)

---

## Season end

Nothing to do. After the final round:
- `matches` collection stays as-is (historical data).
- `collectFixtures` will start populating new-season fixtures
  automatically when football-data.org publishes them.
- `recommendations/current` stays on the last picks until the next
  worker run finds new analyzed matches.
