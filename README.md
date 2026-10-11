# Brand monitoring — slices 0–4

Requires Node 22.18+ and pnpm 11.25.0, plus Docker Compose v2.

## Run

1. `cp .env.example .env`; replace both database passwords and both matching URL passwords. Generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`.
2. Create a Google web OAuth client. Set the client ID/secret in `.env` and register `http://localhost:3000/api/auth/callback/google` as its redirect URI. Production uses HTTPS and its corresponding URI.
3. `pnpm install --frozen-lockfile`
4. `docker compose up -d --wait`
5. `pnpm db:migrate`
6. `pnpm users:set your-google-email@example.com admin active`
7. `pnpm dev`; open http://localhost:3000. In another terminal: `pnpm worker:dev`.

Production build: `pnpm build`, then `pnpm start`. The build uses Next.js's supported Webpack compiler because Turbopack's compiler port is unavailable in restricted environments. Configure HTTPS for secure cookies in production.

Slice 3: after `pnpm db:migrate`, keep `pnpm worker:dev` running to process the article links from saved detection previews. Run `pnpm worker:scan` to refresh active RSS/sitemap sources and every supplied listing page once, then drain discovered article work. Listing sites and their additional listing URLs/scan depth are supported. Each site adds at most 100 new article URLs per scan, ordered by publication evidence then newest discovery. Stale sources (no entry within seven days) appear in detection details and yield to supplied listings. `pnpm worker:scan --site <UUID>` refreshes one site's endpoints and drains the shared queue. Use `--retry-errors` for an explicit retry of failed article fetches. `pnpm worker:rematch` applies current keywords to stored bodies without fetching again. `pnpm samples:check` prints extraction/date results for the ignored local HTML samples.

Slice 4: open `/mentions`. New, All (24h), and Flagged include verified publication in the last 24 hours plus date-unverified articles first discovered within that window, always marked "Date not verified". The 6/12/24h filters use publication for verified articles and first discovery for unverified articles. Rediscovery never resets first discovery; the discovery fallback never verifies a date. New trusted publication evidence may verify it. Date unverified keeps all unresolved dates, including older discoveries; Show older explicitly includes history. Verified future publications stay excluded. Filter by keyword/site/source/status. Admins/analysts can review, flag or ignore single/bulk selections; viewers can read. See [slice 4 notes](docs/slice-4.md).

## Test

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:integration` (uses configured PostgreSQL for auth/client tests; slices 2–3 use disposable databases and require migration credentials with CREATE DATABASE; files run serially because runtime-role changes are shared across databases)
- `pnpm build`
- `pnpm samples:check` (private captures in `tests/fixtures/real-samples/`; those fixture tests explicitly skip when captures are absent)
- Open `/api/me` signed out: 401. Sign in with an approved Google account: 200 with role. Unapproved accounts cannot sign in. `pnpm users:set your-google-email@example.com admin disabled` revokes sessions and denies access immediately; restoring `active` requires another sign-in.
- Repeat with analyst/viewer approvals to inspect the role. Open `/clients`: admin/analyst can add, edit and delete clients and keywords; viewers can read them. Aliases/exclusions use one term per line. Boolean JSON syntax is documented in [slice 1 notes](docs/slice-1.md).

On a **disposable database**, verify rollback and fresh setup with `pnpm db:rollback`, `pnpm db:migrate`, then `pnpm test:integration`. Rollback removes the latest slice: slice 3 removes articles, URL aliases, discoveries, mentions and keyword matches; further rollbacks remove slice 2, slice 1, then slice 0. The shared `pg_trgm` extension and restricted login role remain. Migration execution is transactional, advisory-locked and idempotent.

## Scope

Auth and team approvals use Better Auth's `user`, `session`, `account`, `verification`, plus `app_users` and the migration ledger. Slice 1 adds only `clients` and `keywords` (aliases, exclusions, validated Boolean AST, active state and revision). Deleting a client deletes its keywords. Slice 2 adds only `watched_sites` and `site_endpoints`. Open `/sites` to add one site, paste a list, or upload CSV. Valid sites are saved even when detection fails. Slice 3 adds only `articles`, `article_urls`, `article_candidates`, `mentions`, and `mention_matches`. The server extracts text, verifies publication evidence, matches all active clients' keywords, merges canonical identities and guards current reads with the rolling 24h rule. Older and unverified matches stay stored. Slice 4 adds the `/mentions` dashboard using these existing tables, with client-scoped filters, highlighting, tab counts, live rolling expiry and single/bulk review actions. No new tables are needed. No scheduler, extension, scan-run, clustering or date-review tables are added.

See [slice 0 notes](docs/slice-0.md) for auth/database details, [slice 2 notes](docs/slice-2.md) for site management, and [slice 3 notes](docs/slice-3.md) for processing rules and real-sample results.
