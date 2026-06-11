# CLAUDE.md — TotoLab

---

## Work rules

- Explain what you're about to build in Korean (one paragraph) before starting.
- Work on one feature at a time. Never work on multiple features simultaneously.
- Summarize what changed in Korean after completing work.
- Always keep the project in a buildable state. Never leave it broken.
- The user decides when to start and stop. Claude must not suggest ending work.

## Language rules

- All explanations to the user: Korean.
- Code comments: English.
- Documentation (README.md, CLAUDE.md, etc.): English.
- When starting a new project, create both README.md (English) and README_kr.md (Korean).

## README format

New project READMEs must follow this section order:

```
1. Badges (license, platform, version)
2. Project name + one-line description
3. Target user + problem solved
4. Key features (categorized)
5. Screenshots or demo
6. Install/run instructions (copy-paste code blocks)
7. Roadmap (text diagram + table)
8. Architecture (Mermaid diagram)
9. License
```

Tone: concise and confident, no excessive promotional language.

## Branch rules

- Pushing directly to `main` is allowed (solo project, no PR review
  required). Use a branch only when the work benefits from one.
- New feature: `feature/#issue-number-short-description`
- Bug fix: `fix/#issue-number-short-description`

## Commit rules

- Format: `type: description (closes #number)`
- Types:
  - `feat`: new feature
  - `fix`: bug fix
  - `refactor`: code cleanup
  - `docs`: documentation changes
- Examples:
  - `fix: fix streak bug (closes #38)`
  - `feat: add category feature (closes #51)`

---

## Project overview

TotoLab is a single-page web app that surfaces value bets on upcoming
EPL fixtures. The analysis pipeline runs as a GitHub Actions cron job
that spawns the Claude Code CLI headlessly (subscription OAuth auth,
$0 in API spend) and writes structured analysis to Firestore. The
frontend reads Firestore directly and renders picks, match cards, and
a track-record dashboard.

## Folder structure

```
toto-lab/
├── index.html               # Frontend SPA (Tailwind CDN, Firebase SDK via CDN)
├── firebase.json            # Hosting + Functions + Firestore config
├── firestore.rules          # Security rules (public read, server-only write)
├── firestore.indexes.json   # Composite indexes
├── CLAUDE.md
├── OPERATIONS.md            # Day-to-day runbook (Korean)
├── README.md
├── ideas/                   # Feature idea drafts
├── .github/workflows/
│   ├── worker.yml           # Daily analysis cron (12:00 KST) + manual dispatch
│   └── deploy.yml           # firebase deploy on push to main
├── functions/               # Cloud Functions — fixtures, results, Telegram notifier
│   ├── index.js
│   ├── footballData.js      # football-data.org API wrapper
│   ├── oddsApi.js           # The Odds API wrapper (also used by worker)
│   └── devig.js             # de-vig math (also used by worker)
└── worker/                  # Analysis runner (GitHub Actions)
    ├── runOnce.js           # entrypoint
    ├── pipeline.js          # orchestrates fan-out + recommendations
    ├── analyzer.js          # headless Claude Code CLI wrapper
    └── firestore.js         # Firebase Admin SDK init
```

## Where things run

| Job | Where | Trigger |
|---|---|---|
| Fixture collection (next 7 days) | Cloud Functions | cron 06:00 KST daily |
| Result collection | Cloud Functions | cron 09:00 KST daily + 23:00 Sat/Sun |
| Match analysis (next 24h) | GitHub Actions (`worker.yml`) | cron 12:00 KST daily + manual dispatch |
| Telegram alert on new picks | Cloud Functions | Firestore trigger on `recommendations/current` |
| Worker failure alert | GitHub Actions (`worker.yml`) | Telegram message on failed run |
| Static site + Functions deploy | GitHub Actions (`deploy.yml`) | push to `main` |

## Build and run

```bash
# Functions (local emulation, deploy)
cd functions && npm install && cd ..
firebase emulators:start
firebase deploy
firebase deploy --only functions
firebase deploy --only hosting

# Worker (manual local run — needs a logged-in `claude` CLI)
cd worker && npm install
node runOnce.js          # default 24h window
node runOnce.js 48       # override window for one-off
```

The scheduled worker runs in GitHub Actions; trigger it manually via
Actions → "Daily analysis worker" → Run workflow (horizon input).

Required environment variables:

| Var | Where | Used by |
|---|---|---|
| `FOOTBALL_DATA_TOKEN` | `functions/.env` + Actions secret | both |
| `ODDS_API_KEY` | Actions secret (`worker`), `functions/.env` | worker |
| `ADMIN_TOKEN` | `functions/.env` + Actions secret | manual HTTP endpoints |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | `functions/.env` + Actions secrets | notifier, worker failure alert |
| `CLAUDE_CODE_OAUTH_TOKEN` | Actions secret | worker (Claude CLI auth in CI) |
| `CLAUDE_MODEL` (default `claude-sonnet-4-6`) | optional env | worker |
| `FIREBASE_SERVICE_ACCOUNT` | Actions secret (JSON) | worker (Firestore Admin) |
| `FIREBASE_TOKEN` | Actions secret | `deploy.yml` (firebase-tools auth) |

`functions/.env` is gitignored; `deploy.yml` recreates it from Actions
secrets at deploy time (firebase-tools bakes it into the Functions
runtime). No Anthropic API key anywhere — the worker spawns the Claude
Code CLI under the user's subscription.

## Screens

Single-page app (`index.html`):

| Section | Description |
|---|---|
| Value Picks | Top recommendations for the current round (EV, edge, odds, acca) |
| All Analysed Fixtures | Match cards with 1X2 + O/U probabilities, confidence badge, reasoning bullets (EN + KR) |
| Track Record | Hit rate, P&L (£10 flat stake), ROI, breakdown by pick type |

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS + Tailwind CSS (CDN) |
| Hosting | Firebase Hosting |
| Database | Firestore |
| Cloud jobs | Firebase Functions (Node 22, ESM) |
| Analysis runtime | Node 22 on GitHub Actions (`ubuntu-latest`) |
| AI | Claude Sonnet 4.6 via headless Claude Code CLI (subscription OAuth) |
| Data — Fixtures | football-data.org API v4 |
| Data — Odds | The Odds API v4 |
| CI/CD | GitHub Actions (GitHub-hosted runners) |

## Key conventions

- Worker is **analysis only**. Fixture/result collection lives in Cloud
  Functions to keep them on free, always-on infrastructure.
- Worker re-analyzes every match in the 24h window on every run — there
  is no `analyzed: true` skip filter. This keeps injury, odds, and form
  data fresh as kickoff approaches.
- Pick thresholds live in `worker/pipeline.js`: `EDGE_THRESHOLD = 5`,
  `CONFIDENCE_THRESHOLD = 50`, `SECONDARY_CONFIDENCE_MIN = 40`,
  `MAX_PICKS = 3`.
- **Engine v2 is market-anchored**: the model never invents
  probabilities. It returns deltas against the de-vigged fair baseline
  (`MAX_MW_DELTA = 7`, `MAX_OU_DELTA = 6` in `worker/analyzer.js`);
  out-of-range deltas are zeroed (not clamped), 1X2 deltas re-centered
  to sum 0, the draw is floored at fair − 2pp, and a big delta with
  confidence < 50 is discarded as self-contradictory. Pick = largest
  model-vs-fair edge ≥ `EDGE_THRESHOLD` among priced outcomes, computed
  on fractional probs (`probsExact`) in `selectPick`. Engine math is
  unit-tested in `worker/v2math.test.mjs` (runs in `worker.yml`).
- Injury data is fetched live by `worker/analyzer.js#fetchTeamInjuries`
  via the Claude CLI's WebSearch tool — no pre-uploaded Firestore
  collection is read.
- `ARSENAL_TEAM_ID = 57` (in `worker/pipeline.js`) is the hardcoded
  fan-team flag — sets `isFanTeam: true` on Arsenal matches so the
  prompt enforces strict data-only reasoning.
- `recommendations/current` holds the active round's picks; overwritten
  on every analysis run.
- `stats/summary` aggregates won/lost/ROI; updated by `collectResults`.
- O/U line per match is the most balanced totals line (smallest
  over/under price gap) from the bookmaker. Stored as
  `overUnder: { line, over, under }` in odds and `ouLine` on the match
  doc. Pick types are `over` / `under` (legacy docs may have
  `over25` / `under25`).
- Edge is computed against the de-vigged sharp book (Pinnacle / Smarkets
  / Betfair) via `computeFairProbs` — Power method for 1X2, Shin method
  for O/U.
- All Analysed Fixtures on the frontend shows upcoming matches
  (kickoff ≥ now, up to 4 days ahead) ascending, then recently finished
  matches (kickoff within last 24h) descending.

## Operational gotchas

- GitHub Actions cron can drift 15–30 min under load — fine for a
  daily noon job, but don't expect to-the-minute firing.
- `CLAUDE_CODE_OAUTH_TOKEN` (Actions secret) is a long-lived token from
  `claude setup-token`. If worker runs start failing with auth errors,
  regenerate it locally and update the secret.
- `analyzer.js` spawns the CLI with `cwd` set to a temp dir on purpose —
  otherwise the CLI auto-discovers this repo's CLAUDE.md and pollutes
  the analysis context with project work rules.
- Cloud Functions `collectResults` skips already-recorded matches; the
  worker does not look at result data at all.

## Future features

### Must do (off-season 2026 rebuild — see memory)
- Analysis engine v2: market-anchored probabilities (de-vigged sharp
  prior + evidence-backed deltas), draw-probability guard, no pick
  without stored odds, O/U push handling, CLV tracking

### Nice to have
- Multi-league support (La Liga, Bundesliga)
- Confidence calibration chart (predicted vs actual win rate by band)
- User accounts with custom edge/confidence thresholds
