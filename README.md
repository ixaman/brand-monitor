# Brand monitoring — slices 0–2

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
- `pnpm test:integration` (uses configured PostgreSQL for auth/client tests; slice 2 uses a disposable database and requires migration credentials with CREATE DATABASE)
- `pnpm build`
- Open `/api/me` signed out: 401. Sign in with an approved Google account: 200 with role. Unapproved accounts cannot sign in. `pnpm users:set your-google-email@example.com admin disabled` revokes sessions and denies access immediately; restoring `active` requires another sign-in.
- Repeat with analyst/viewer approvals to inspect the role. Open `/clients`: admin/analyst can add, edit and delete clients and keywords; viewers can read them. Aliases/exclusions use one term per line. Boolean JSON syntax is documented in [slice 1 notes](docs/slice-1.md).

On a **disposable database**, verify rollback and fresh setup with `pnpm db:rollback`, `pnpm db:migrate`, then `pnpm test:integration`. Rollback removes the latest slice: slice 2 removes watched sites/endpoints; further rollbacks remove slice 1, then slice 0. The shared `pg_trgm` extension and restricted login role remain. Migration execution is transactional, advisory-locked and idempotent.

## Scope

Auth and team approvals use Better Auth's `user`, `session`, `account`, `verification`, plus `app_users` and the migration ledger. Slice 1 adds only `clients` and `keywords` (aliases, exclusions, validated Boolean AST, active state and revision). Deleting a client deletes its keywords. Slice 2 adds only `watched_sites` and `site_endpoints`. Open `/sites` to add one site, paste a list, or upload CSV. Valid sites are saved even when detection fails. Keep `pnpm worker:dev` running for sequential RSS/sitemap/listing detection and previews. No article, job, extension or global settings tables exist. Slice 1 tests cover CRUD/client scoping, live authorization, invalid rules, revisions and Bangla keyword normalization. Article date/URL/matching/dedup/24h logic and tests start in slice 3.

See [slice 0 notes](docs/slice-0.md) for auth/database details and [slice 2 notes](docs/slice-2.md) for import formats, detection limits, endpoint settings and rollback.
