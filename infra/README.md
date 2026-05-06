# Infrastructure

Production runs on a single Contabo VPS. systemd handles scheduling, a
GitHub Actions self-hosted runner handles deploys.

## Layout on the VPS

```
/root/
├── deploy.sh            # multi-tenant deploy script (toto-lab / ai-debate / my-life-os)
├── .firebase-sa.json    # Firebase service account (worker auth)
├── .firebase_token      # firebase-cli auth (deploy step)
├── toto-lab/            # this repo, deployed via git pull
└── ai-debate/           # the ai-debate bridge (separate repo)

/etc/systemd/system/
├── totolab-worker.timer    # fires daily at 12:00 KST
├── totolab-worker.service  # one-shot — runs runOnce.js
└── ai-debate.service       # always-on bridge (Restart=always)
```

The files in [`systemd/`](./systemd/) and [`deploy.sh`](./deploy.sh) here
are the canonical versions tracked in git. The VPS holds working copies
that should match — when you change anything here, sync it to the VPS
manually (no auto-deploy for infra).

## Runtime contract

- **toto-lab worker** = analysis only. Re-analyzes every match in the
  next 24h on every run. Fires once a day at 12:00 KST.
- **toto-lab Cloud Functions** = fixture collection (06:00 KST daily),
  result collection (09:00 + Sat/Sun 23:00 KST), Telegram notifier,
  health endpoint.
- **ai-debate** = HTTP bridge on `localhost:3000`. Spawns Claude Code CLI
  under the user's subscription, so worker analyses cost $0 in API spend.
  Must be `active (running)` for worker runs to succeed.

## Install / update on the VPS

After editing a unit file in this repo:

```bash
# from /root/toto-lab on the VPS
sudo cp infra/systemd/totolab-worker.timer   /etc/systemd/system/
sudo cp infra/systemd/totolab-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now totolab-worker.timer
```

For ai-debate.service, do the same from the ai-debate repo (this is a
reference copy here; the canonical owner is that repo).

For `deploy.sh`:

```bash
# from /root/toto-lab on the VPS
sudo cp infra/deploy.sh /root/deploy.sh
sudo chmod +x /root/deploy.sh
```

## Verify

```bash
# next firing
systemctl list-timers | grep -i totolab

# last run summary
systemctl status totolab-worker.timer
systemctl status totolab-worker.service

# last run logs
journalctl -u totolab-worker.service -n 100 --no-pager

# ai-debate health
systemctl status ai-debate
curl -s http://localhost:3000/api/health
```

## Manual one-off run (skip the schedule)

```bash
sudo systemctl start totolab-worker.service
journalctl -u totolab-worker.service -f
```

To run with a wider window (e.g., re-analyze 48h instead of the default
24h):

```bash
cd /root/toto-lab/worker
sudo node runOnce.js 48
```

## Why ai-debate is a hard dependency

`totolab-worker.service` declares `After=ai-debate.service` and
`Wants=ai-debate.service`. If ai-debate is down at firing time, the
worker still starts but every per-match analysis fails with a connection
error and the run produces no recommendations. There is no automatic
retry — the next firing is 24h later.

`Wants=` (soft) is used deliberately: a brief ai-debate restart should
not abort the run; ai-debate's own `Restart=always` recovers it within
seconds. If you change this to `Requires=` you will lose entire days of
analysis when ai-debate is between restarts.

## Secrets

Not tracked in git. Live on the VPS only:

| File | Used by |
|---|---|
| `/root/.firebase-sa.json` | worker (Admin SDK) |
| `/root/.firebase_token` | deploy.sh (firebase CLI) |
| `/root/toto-lab/worker/.env` | worker (FOOTBALL_DATA_TOKEN, ODDS_API_KEY) |
| `/root/toto-lab/functions/.env` | Cloud Functions runtime config |

Telegram bot token + chat id are set in the Cloud Functions runtime
config (managed via `firebase functions:secrets`), not on the VPS.
