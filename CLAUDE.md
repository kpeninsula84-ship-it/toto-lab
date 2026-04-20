# CLAUDE.md — [PROJECT_NAME]

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

<!-- PROJECT-SPECIFIC RULES BELOW -->

## Project overview

<!-- What does this project do? One paragraph. -->

## Folder structure

```
<!-- Fill in the project folder structure -->
```

## Build and run

```bash
<!-- Fill in build/run commands -->
```

## Screens

<!-- List the main screens/pages of the app -->

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| | | |

## Key conventions

<!-- Project-specific coding conventions, data rules, etc. -->

## Known issues

| Issue | Detail |
|---|---|
| | |

## Future features

### Must do
- [ ] 

### Nice to have
- [ ] 
