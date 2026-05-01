# Migrate analyzer from Anthropic API to ai-debate bridge

**Status:** Pending decision (NAS hardware check, ETA 2026-05-05~06)

## Idea

Replace `client.messages.create()` calls in `functions/analyzer.js` with HTTP
calls to ai-debate's `/api/analyze` endpoint, which internally spawns Claude
Code CLI under the user's subscription. Result: Anthropic API charges drop to
**zero** for match analysis (currently the bulk of API usage). Same pattern
will benefit any future leagues added (KBO, LaLiga, etc.).

## Discussion

### Current state (2026-05-01)

- `functions/analyzer.js` calls Anthropic SDK directly for `analyzeMatch()`.
- Cron jobs (`analyzeWeekday`, `analyzeSaturday`) run on Cloud Functions and
  drive the bulk of API usage.
- Injuries are pre-fetched and stored in Firestore `/injuries/{teamId}`,
  uploaded weekly via CI from `injuries-payload.json` — so analysis no
  longer depends on `web_search` from inside the analyzer prompt.
- `fetchTeamInjuries()` (legacy, web_search-based) still exists in
  `analyzer.js` but is only used by the manual injury-collection helper,
  not the main analysis path.

### Already in place (discovered during planning)

- `ai-debate/server/routes/analyze.js` — `POST /api/analyze` endpoint
  exists and works. Accepts `{systemPrompt, userPrompt, model}`, returns
  `{data, usage}` after extracting JSON from CLI output.
- `ai-debate/server/agents/claude.js` — `streamRun()` spawns
  `claude -p ... --output-format stream-json` under the user's local
  Claude Code subscription. No Anthropic API charges.

### What still needs to change

1. `functions/analyzer.js` — replace `client.messages.create(...)` in
   `analyzeMatch()` with `fetch(AI_DEBATE_URL/api/analyze, ...)`.
2. Move the analysis cron off Cloud Functions (which cannot reach a
   Mac/NAS hosted ai-debate).
3. Pick a host for ai-debate that's online at scheduled analysis time.

### Hosting decision (pending NAS hardware check)

| Option | Monthly cost | Up-front | Notes |
|---|---|---|---|
| **NAS (existing, model TBD)** | ₩0 | 2-3h setup | Best if Docker-capable |
| Hetzner CX22 | ~₩6,500 | 1h setup | Reliable fallback |
| Raspberry Pi 5 (8GB) | ~₩1,000 (electricity) | ₩100,000 + 2-3h | Long-term cheapest |
| Oracle Cloud Free ARM | ₩0 | 2-4h | Account/capacity risk |

Decision tree once NAS model is known:

```
NAS supports Docker (Synology + series, QNAP TS-x53+, ASUSTOR)
  → Host ai-debate on NAS, ₩0/month
NAS does NOT support Docker (Synology j series, low-end)
  → Hetzner CX22 (~₩6,500/month)
```

### Phased rollout (planned)

**Phase 1 — Mac local (validation, 1-2 weeks)**
- Disable `analyzeWeekday` / `analyzeSaturday` Cloud Functions cron.
- Add `scripts/analyze.js` invoked by macOS launchd at the existing
  cron time (12:00 KST).
- Script reads pending fixtures from Firestore via Admin SDK, calls
  `http://localhost:3000/api/analyze`, writes results back.
- Validates the bridge end-to-end before committing to a hosting choice.

**Phase 2 — Migrate ai-debate to chosen host**
- NAS or Hetzner gets ai-debate running 24/7.
- toto-lab analysis cron either:
  - Stays on Cloud Functions, calling the public ai-debate URL
    (Cloudflare Tunnel or Hetzner public IP), OR
  - Moves to the same host as ai-debate (cleaner, no public exposure).

### Multi-league applicability

The bridge is league-agnostic. When KBO baseball or other leagues are
added, they hit the same `/api/analyze` endpoint. API savings scale with
the number of leagues; the per-league marginal cost is zero.

### Risks acknowledged

- **TOS grey area**: Claude Code subscription is intended for interactive
  developer use; using it as a programmatic backend for cron analysis is
  not explicitly forbidden but is not the intended pattern. Personal-use
  scale is low risk.
- **Subscription rate limits**: Claude Pro caps ~45 messages per 5h
  window. toto-lab's usage (10 matches/week) is far below this.
- **JSON parsing**: CLI output isn't guaranteed valid JSON like
  `output_config.json_schema` is. The bridge already has fallback
  extraction (markdown fence + `{...}` substring). Acceptable for
  validation phase.
- **Loss of `web_search` in analyzer**: Already not used in the main
  analysis path (injuries pre-fetched). No regression.

## Conclusion

Plan is sound and partially built. **Blocker = NAS hardware check
(2026-05-05~06)**. Until then, current Cloud Functions + API setup keeps
running normally; cost over the waiting period is negligible (~$0.50).

When NAS is checked:
- Docker-capable → host ai-debate on NAS, build Phase 1 script, run for
  1-2 weeks, then either keep Mac+NAS or migrate cron to NAS too.
- Not capable → Hetzner CX22, same Phase 1 plan but pointing at Hetzner.

No code changes required right now. This document captures the decision
context so any session can pick up after the NAS check.
