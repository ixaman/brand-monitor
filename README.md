# Brand monitoring — slice 0

Requires Node 22.18+ and pnpm 11.25.0, plus Docker Compose v2.

## Run

1. `cp .env.example .env`; replace both database passwords and both matching URL passwords. Generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`.
2. Create a Google web OAuth client. Set the client ID/secret in `.env` and register `http://localhost:3000/api/auth/callback/google` as its redirect URI. Production uses HTTPS and its corresponding URI.
3. `pnpm install --frozen-lockfile`
4. `docker compose up -d --wait`
5. `pnpm db:migrate`
6. `pnpm users:set your-google-email@example.com admin active`
7. `pnpm dev`; open http://localhost:3000. In another terminal: `pnpm worker:dev`.

Production build: `pnpm build`, then `pnpm start`. Configure HTTPS for secure cookies in production.

## Test

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:integration` (uses configured real PostgreSQL; creates and removes synthetic auth records)
- `pnpm build`
- Open `/api/me` signed out: 401. Sign in with an approved Google account: 200 with role. Unapproved accounts cannot sign in. `pnpm users:set your-google-email@example.com admin disabled` revokes sessions and denies access immediately; restoring `active` requires another sign-in.
- Repeat with analyst/viewer approvals to inspect the role. Viewer has read-only authorization; management screens arrive in later slices.

On a **disposable database**, verify rollback and fresh setup with `pnpm db:rollback`, `pnpm db:migrate`, then `pnpm test:integration`. Rollback removes all slice 0 data. The shared `pg_trgm` extension and restricted login role remain. Migration execution is transactional, advisory-locked and idempotent.

## Scope

Only auth and team approvals exist: Better Auth's `user`, `session`, `account`, `verification`, plus `app_users`, and the migration ledger. No client, keyword, article, job, extension or settings tables yet. Worker checks database/Redis connectivity and stays alive without registering jobs. Domain business rules and their required date/URL/Bangla/dedup/24h tests start in slice 3.

See [slice 0 notes](docs/slice-0.md) for auth and database details.
