# TotoLab Analysis Worker

Daily EPL match analysis runner. Runs on GitHub Actions
([`worker.yml`](../.github/workflows/worker.yml)) at 12:00 KST, spawning
the Claude Code CLI headlessly under the user's subscription (zero
Anthropic API spend).

This worker is **analysis-only**. Fixture collection (06:00 KST) and
result collection (09:00 + Sat/Sun 23:00 KST) run on Cloud Functions —
see [`functions/index.js`](../functions/index.js).

## How it runs

The Actions cron fires daily and runs:

```
node runOnce.js 24
```

`runOnce.js` re-analyzes every match kicking off in the next 24 hours.
There is no `analyzed` skip flag — each run picks up the freshest
injury, odds, and form data ahead of kickoff. A failed run sends a
Telegram alert with a link to the logs.

## Files

| File | Purpose |
|---|---|
| `runOnce.js` | entrypoint; loads `.env` if present, calls pipeline |
| `pipeline.js` | orchestrates fan-out per match + writes recommendations |
| `analyzer.js` | spawns `claude -p` headlessly, parses the JSON envelope |
| `firestore.js` | Firebase Admin SDK init |

## Manual run

In CI: Actions → **Daily analysis worker** → Run workflow (`horizon`
input widens the window).

Locally (needs a logged-in `claude` CLI):

```
cd worker
node runOnce.js          # default 24h window
node runOnce.js 48       # one-off wider sweep
```

## Environment

In CI these come from Actions secrets; locally from `worker/.env`
(or `WORKER_ENV_PATH`):

- `FOOTBALL_DATA_TOKEN`
- `ODDS_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN` — CLI auth in CI (locally the logged-in CLI is used)
- `CLAUDE_MODEL` (default `claude-sonnet-4-6`)
- `CLAUDE_BIN` (default `claude`)
- `GOOGLE_APPLICATION_CREDENTIALS` — path to Firebase service account JSON
