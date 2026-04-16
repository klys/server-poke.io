# AGENTS.md

## Client-Server Contract

In case of changes that require server side refactor use contracts.json to find the other side that require to be updated.
- if contracts.json dont exists request to be created before doing any work that require server side refactor.
- validate contracts.json to have the following format example:

```
{
    "frontend_location": "<file/system/path>"
}
```

Project Summary

## Purpose

This repository is a TypeScript backend for a real-time multiplayer game. It combines:

- Socket.IO gameplay events and world simulation
- Redis-backed authentication and session storage
- Optional SMTP-backed transactional email delivery

Treat this file as the quick-start guide for coding agents working in this repo.

## Working Agreement

- Keep changes small and targeted unless the task clearly calls for a broader refactor.
- Preserve the current event names and payload shapes unless the client contract is being intentionally changed.
- If you change Socket.IO event types, update the corresponding files in `Server/` and `Server/registerSocketHandlers.ts` together.
- If you change authentication flows, keep Redis key usage and token TTL behavior aligned with `components/Auth.ts`.
- Do not assume SMTP is available in development. The server is allowed to run with email delivery disabled.

## Common Commands

- Install dependencies: `npm install`
- Run in dev mode: `npm run dev`
- Build TypeScript: `npm run build`
- Run built server: `npm start`

There is currently no dedicated automated test suite in `package.json`, so `npm run build` is the main validation step after code changes.

## Local Services

- Redis is required for startup. Default URL: `redis://127.0.0.1:6379`
- Start a local Redis container: `./redis_dev_start.sh`
- Mailpit is the recommended local SMTP sink for development
- Start Mailpit with compose helper: `./smtp_dev_start.sh`
- Mailpit UI: `http://localhost:8025`
- SMTP development notes live in `SMTP_DEV.md`

## Environment

Copy values from `.env.example` when setting up a local environment. Important variables:

- `PORT`: server port, defaults to `3001`
- `CLIENT_ORIGIN`: allowed Socket.IO CORS origin, defaults to `http://localhost:3000`
- `REDIS_URL`: Redis connection string
- `JWT_SECRET`: required for stable auth behavior; the app falls back to an unsafe dev default if missing
- `AUTH_*_TTL_SECONDS`: auth/session/email-token TTL controls
- `APP_PUBLIC_URL`, `EMAIL_VALIDATION_PATH`, `PASSWORD_RESET_PATH`: used to build links in outgoing emails
- `SMTP_*`: if missing, the app starts with email delivery disabled

## Repository Map

- `index.ts`: bootstrap entrypoint; wires Redis, mail, auth, world, and Socket.IO
- `components/Auth.ts`: registration, login, sessions, password reset, email verification
- `components/DBInit.ts`: Redis client initialization and auth metadata bootstrap
- `components/MailService.ts`: SMTP setup plus HTML email template rendering
- `components/world.ts`: world state, projectile loop, respawn loop, object broadcasting
- `components/player.ts`: player state and movement/pathfinding logic
- `components/projectil.ts`: projectile behavior
- `components/gameMath.ts`: geometry and collision helpers
- `Server/registerSocketHandlers.ts`: main Socket.IO event registration
- `Server/*.ts`: typed Socket.IO event contracts
- `emails/*.html`: templates used by `MailService`

## Architecture Notes

- The server starts by initializing Redis and mail, then creates `Auth` and `World`, then registers socket handlers.
- `World` owns the in-memory gameplay state. Players and projectiles are not persisted.
- Projectile updates run on an interval in `components/world.ts`.
- Respawn waiting logic also runs in `components/world.ts`.
- Authentication state is stored in Redis and hydrated onto `socket.data`.

Redis auth keys currently follow these patterns:

- `auth:session:{sessionId}`
- `auth:user:{userId}`
- `auth:index:username:{username}`
- `auth:index:email:{email}`
- `auth:token:email-validation:{token}`
- `auth:token:password-reset:{token}`

## Change Guidance

- When touching gameplay logic, watch for server-side broadcast frequency and event naming because the client expects dynamic event names like `moveProjectil{id}`.
- When touching auth, preserve the distinction between `auth:error`, `auth:info`, and `auth:session` socket responses.
- When editing email behavior, keep both HTML rendering and plain-text fallback intact in `MailService`.
- When introducing new environment variables, update `.env.example` and any relevant docs.
- Prefer adding or adjusting TypeScript interfaces in `Server/` instead of letting payload shapes drift implicitly.

## Validation Checklist

Before wrapping up a change, do the following when relevant:

- Run `npm run build`
- Verify any new env vars are documented in `.env.example`
- Verify socket event type definitions still match handler usage
- If email templates changed, confirm the placeholder names still match `MailService` replacements
