---
name: verify
description: Validate server-poke.io changes — tsc build gate, the no-Redis progression suite, and real-server E2E socket drivers (trade, battles, field skills) against the redis-dev container.
---

# Verifying server-poke.io changes

Three tiers, cheapest first. There is no jest/vitest suite; these are the
actual gates.

## 1. Build gate (always)

```bash
npm run build        # tsc; the only universal check — run after every change
```

## 2. Progression suite (no Redis, no sockets — fast)

```bash
npm run test:progression      # ts-node tools/testEssentialsProgression.ts
```

Covers RMXP/Essentials semantics: event page selection, script switches,
command-tree parsing, portal gating, teleport validation. Run it whenever you
touch `components/eventPageSelection.ts`, `essentialsScriptAdapters.ts`, or
`EventRuntime.ts` command parsing.

## 3. E2E socket drivers (real server + real Redis)

Drivers in `tools/`: `e2e-trade.ts`, `e2e-field-skills.ts`,
`e2e-water-actions.ts`, `e2e-teach-machines.ts`, `e2e-hidden-venomon-gift.ts`,
`e2e-account-character.ts`, `e2e-chat.ts`.
Each spawns its OWN server process on a custom port (e.g. 3997) and asserts
against authoritative Redis state, not socket payloads.

```bash
bash redis_dev_start.sh                      # redis-dev container must be up
node_modules/.bin/ts-node tools/e2e-trade.ts
```

Before running, check the constants block at the top of the driver:

- **Stale path**: several drivers hardcode
  `SERVER_DIR = "/home/klys/Dev/pokecraft/server-poke.io"` from the old
  workspace location. Point it at this repo
  (`/home/junior-jimenez/Dev/pokecraft/server-poke.io`) or make it
  `__dirname`-relative before running, otherwise the spawned server fails.
- Drivers assume the real game data is loaded in Redis (maps like
  `map-essentials-043` must exist).
- Drivers create throwaway users via `auth:register`; register names must be
  letters only.

## Choosing the tier

| Change | Run |
| --- | --- |
| Any code change | build |
| Event pages / scripts / portals | build + progression |
| Trade | build + `e2e-trade.ts` |
| Field moves / water / TMs / gift events | build + the matching `e2e-*.ts` |
| Chat / friends / blocks / accounts | build + `e2e-chat.ts` + `e2e-account-character.ts` |
| Socket contract shape | build here AND `npm run build` in the client repo (see root `contract-sync` skill) |
| Client-visible behavior | `client-poke.io:verify` skill (headless Chrome) |

## Handoff notes

- If email templates changed: placeholders must still match `MailService`
  replacements (HTML + plain-text fallback).
- If env vars were added: document them in `.env.example`.
- Report driver output honestly — the drivers print PASS/FAIL counts; a
  driver that dies mid-run is a failure, not a skip.
