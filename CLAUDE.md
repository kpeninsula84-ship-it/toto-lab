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

- New feature: `feature/#issue-number-short-description`
- Bug fix: `fix/#issue-number-short-description`

## Commit rules

- Format: `type: description (closes #number)`
- Never commit directly to the main branch.
- Types:
  - `feat`: new feature
  - `fix`: bug fix
  - `refactor`: code cleanup
  - `docs`: documentation changes
- Examples:
  - `fix: fix streak bug (closes #38)`
  - `feat: add category feature (closes #51)`

## Never do

- Never commit directly to main.
- Never merge without a PR.

---

## Project overview

TotoLab is a single-page web app that uses Claude Sonnet to analyse every upcoming EPL fixture and surface value bets. Firebase Functions run on a schedule to collect fixtures, request odds, inject injury data, call the Claude API, and write structured analysis back to Firestore. The frontend reads Firestore directly and renders picks, match cards, and a track-record dashboard.

## Folder structure

```
toto-lab/
├── index.html               # Frontend SPA (Tailwind CDN, Firebase SDK via CDN)
├── firebase.json            # Hosting + Functions + Firestore config
├── firestore.rules          # Security rules (public read, server-only write)
├── firestore.indexes.json   # Composite indexes
├── CLAUDE.md
├── OPERATIONS.md            # Weekly manual injury-update runbook (Korean)
├── ideas/                   # Feature idea drafts
└── functions/
    ├── index.js             # All Cloud Function exports
    ├── analyzer.js          # Claude API call + prompt construction
    ├── footballData.js      # football-data.org API wrapper
    ├── oddsApi.js           # The Odds API wrapper
    └── package.json
```

## Build and run

```bash
# Install function dependencies
cd functions && npm install && cd ..

# Local emulation (functions + firestore)
firebase emulators:start

# Deploy everything
firebase deploy

# Deploy functions only
firebase deploy --only functions

# Deploy hosting only
firebase deploy --only hosting
```

Required environment variables in `functions/.env` (local) or GitHub Secrets (CI):
- `ANTHROPIC_API_KEY`
- `FOOTBALL_DATA_TOKEN`
- `ODDS_API_KEY`

## Screens

Single-page app (`index.html`):

| Section | Description |
|---|---|
| Value Picks | Top recommendations for the current round (EV, edge, odds, acca) |
| All Analysed Fixtures | Match cards with 1X2 + O/U probabilities, confidence badge, reasoning bullets |
| Track Record | Hit rate, P&L (£10 flat stake), ROI, breakdown by pick type |

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| Frontend | Vanilla JS + Tailwind CSS (CDN) | Tailwind 3 |
| Hosting | Firebase Hosting | — |
| Database | Firestore | — |
| Backend | Firebase Functions (Node.js ESM) | Node 22 |
| AI | Anthropic Claude Sonnet via `@anthropic-ai/sdk` | ^0.40.0 |
| Data — Fixtures | football-data.org API | v4 |
| Data — Odds | The Odds API | v4 |
| CI/CD | GitHub Actions | — |

## Key conventions

- All Cloud Functions are in `functions/index.js`; business logic lives in the adjacent modules.
- Functions use ESM (`"type": "module"` in package.json).
- Pick thresholds are constants at the top of `index.js`: `EDGE_THRESHOLD`, `CONFIDENCE_THRESHOLD`, `MAX_PICKS`.
- Injury data is stored in Firestore `injuries/{teamId}` and fetched inside `analyzer.js` before building the Claude prompt.
- `ARSENAL_TEAM_ID = 57` is the hardcoded fan-team flag — set `isFanTeam: true` on Arsenal matches so the prompt enforces strict data-only reasoning.
- Firestore `stats/summary` is the single document for all aggregate pick stats; `stats/visits` is the visitor counter (client-writable).
- `recommendations/current` holds the active round's picks; overwritten each analysis run.
- All monetary values stored in pence (integers) and displayed divided by 100.

## Known issues

| Issue | Detail |
|---|---|
| Injury team name mismatch | `updateInjuriesBulk` may match fewer than 20 teams if football-data.org uses suffixed names ("Arsenal FC" vs "Arsenal") |
| No result auto-detection | `collectResults` only runs Sunday 09:00 KST — late Saturday results not picked up until then |

## Future features

### Must do
- [ ] Telegram / email alert when new value picks are published
- [ ] Historical pick archive (past rounds browsable on frontend)

### Nice to have
- [ ] Multi-league support (La Liga, Bundesliga)
- [ ] Confidence calibration chart (predicted vs actual win rate by confidence band)
- [ ] User accounts with custom edge/confidence thresholds
