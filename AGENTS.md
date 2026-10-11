# Project rules
- Read SPEC.MD before any task. It is the source of truth.
- Work on ONE slice at a time. Never start the next slice on your own.
- Hard rule: the main feed shows only articles published in the last 24 hours.
- The Chrome extension contains NO business logic (see SPEC.MD).
- Write tests for date parsing, URL canonicalization, Bangla matching, dedup, and the 24h logic.
- After each slice: list what changed, how to run it, how to test it, then stop.
- Never commit secrets. Use .env files and keep them in .gitignore.
- Each thread: read AGENTS.md and DECISIONS.md first. Read ONLY the PLAN.md sections relevant to the current slice. Do not read all of PLAN.md.
- Do not re-explain the plan. Keep replies short: files changed, how to run, how to test.

# Implemented conventions (slice 0)
- Source filename is `SPEC.md` (case sensitive); read it before work.
- pnpm workspace: `apps/web` (Next.js/React), `apps/worker` (always-on Node/BullMQ), `packages/domain` (server only), `db/migrations` (one up/down pair per slice).
- Dependencies are exact-pinned in `package.json` and `pnpm-lock.yaml`. Node 22.18+, pnpm 11.25.0; PostgreSQL 18 and Redis via Compose.
- Google auth uses Better Auth. Every protected request checks the current approval state and role in PostgreSQL. Use maintained library auth/crypto only.
- Use migration credentials only for migrations/operator user approvals; application processes use restricted runtime credentials.
- UTC storage/connections; Asia/Dhaka display. Extension remains raw-only and must never import domain code.
- Run `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and `pnpm build` for applicable changes. Add meaningful domain/fixture tests when those rules/parsers arrive in their authorized slices.
- Current commands and rollback instructions are in README.md. After one authorized slice, report files changed, run/test commands, then stop.
