# TotoLab Analysis Worker

Daily EPL match analysis runner. Lives on the VPS, fired by a systemd
timer at 12:00 KST. Calls the [ai-debate](https://github.com/.../ai-debate)
bridge to invoke Claude under the user's subscription (zero Anthropic
API spend).

This worker is **analysis-only**. Fixture collection (06:00 KST) and
result collection (09:00 + Sat/Sun 23:00 KST) run on Cloud Functions —
see [`functions/index.js`](../functions/index.js).

## How it runs

Every day at 12:00 KST the systemd timer fires:

```
node /root/toto-lab/worker/runOnce.js
```

`runOnce.js` re-analyzes every match kicking off in the next 24 hours.
There is no `analyzed` skip flag — each run picks up the freshest
injury, odds, and form data ahead of kickoff.

## Files

| File | Purpose |
|---|---|
| `runOnce.js` | systemd entrypoint; loads `.env`, calls pipeline |
| `pipeline.js` | orchestrates fan-out per match + writes recommendations |
| `analyzer.js` | thin wrapper around the ai-debate `/api/analyze` endpoint |
| `firestore.js` | Firebase Admin SDK init |

## Manual run (override window)

```
cd /root/toto-lab/worker
node runOnce.js          # default 24h window
node runOnce.js 48       # one-off wider sweep
```

## Environment

Loaded from `worker/.env` (or `WORKER_ENV_PATH`):

- `FOOTBALL_DATA_TOKEN`
- `ODDS_API_KEY`
- `AI_DEBATE_URL` (default `http://localhost:3000`)
- `AI_DEBATE_MODEL` (default `claude-sonnet-4-6`)
- `GOOGLE_APPLICATION_CREDENTIALS` — path to Firebase service account JSON

## Logs

```
journalctl -u totolab-worker.service -n 100 --no-pager
```

## Infrastructure

systemd unit files are tracked in [`infra/systemd/`](../infra/systemd/).
