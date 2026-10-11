# Slice 2: watched sites and detection previews

Run `pnpm db:migrate`, `pnpm dev`, and (in a separate terminal) `pnpm worker:dev`. Sign in and open `/sites`. Admins/analysts can manage the shared sites; viewers can read previews. Every action checks the current approval/role in PostgreSQL.

## Adding sites

- **Add one site:** URL is required; name is optional and defaults to the hostname.
- **Bulk paste:** one URL or `name, URL` per line. Blank lines are ignored. Quote names containing commas.
- **CSV upload:** header contains `url`, optionally `name` and `listing_url`, in any order. BOM, CRLF and escaped CSV quotes are supported. Records must each fit on one physical line so a broken quoted row cannot swallow the remaining import. Maximum 512 KiB / 1000 nonblank data rows.

URL normalization adds HTTPS when absent, lowercases the host, strips fragments/trailing slashes and known tracking parameters (`utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`), and sorts query parameters. Identifying parameters and path case remain. HTTP and HTTPS remain distinct. Public HTTP(S) URLs only; credentials, internal/private hosts and nonstandard ports are rejected.

Every nonblank input row gets an **Added**, **Skipped (duplicate)** or **Invalid** result with a reason. Database uniqueness also handles concurrent imports. A duplicate does not overwrite its existing settings. Results remain visible during automatic detection updates; they are not retained as import history after leaving the page.

## Detection

Valid sites are saved one by one with detection queued. The worker processes persisted rows sequentially, using a PostgreSQL advisory lock across worker processes and a 750 ms gap between sites. No browser or long-lived web request is required. A crashed worker can resume queued/detecting rows. Revision checks prevent an old result overwriting changed settings or a new detection request.

Detection tries RSS/Atom (configured, advertised, common paths), then robots-advertised/common XML or news sitemaps (including indexes), then configured/homepage listing pages and bounded section links. Failure leaves the site saved as **Needs attention**, with diagnostics. CAPTCHA/403/429 pages are marked method **extension**; this slice does not run an extension.

Per-site timeout: 20 seconds. Per HTTP operation (including DNS/redirects): 4 seconds. Limits: 12 discovery requests, 3 redirects per request, 1 MiB per response, 8 preview links, sitemap depth 2 / 4 sitemap pages and at most 3 listing pages at configured depth 0–2. Redirects preserve the publisher's required path slash. Every network destination is DNS-validated and its public IP pinned to the socket; each redirect is validated again. No user cookies or credentials are sent. XML DTD/entity declarations are rejected.

**Re-run detection** queues one site again. **Site settings** supports name, source timezone (default Asia/Dhaka), active state, listing URL, listing depth and multiple explicit feed/sitemap/listing endpoints. **Save settings and detect** validates and saves the configuration, then queues detection. Dates in the UI are displayed in Dhaka time.

The preview shows recent source entries ordered by parseable source timestamps where available; undated listing links retain source order. Raw publication evidence is labeled, and generic sitemap `lastmod` is labeled **Modified**. Previews are discovery samples, not verified articles or a mentions feed. Automatic scheduled collection, article extraction and 24-hour eligibility remain in later slices.

## Storage and verification

Only `watched_sites` and `site_endpoints` are created in `002_slice2`. There are no scan/job/article/import-history tables.

Run `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`. Slice 2 integration tests create and drop a disposable database using migration credentials (requires CREATE DATABASE), leaving existing saved sites untouched. Fixtures are synthetic Bangla RSS, Atom, news sitemap/index and listing examples. Tests cover input normalization/validation, bad-row continuation, database and concurrent duplicates, authorization, endpoint/timezone settings, previews, ordered fallback, safe DNS/redirect/body limits, timeouts, serial workers, crash recovery, revision fencing and migration rollback/reapply.

On a disposable database, `pnpm db:rollback` removes slice 2 sites/endpoints while preserving slices 0–1. `pnpm db:migrate` restores empty slice 2 tables.

Parser reference: [Cheerio HTML/XML configuration](https://cheerio.js.org/docs/advanced/configuring-cheerio/). Network reference: [Node.js DNS lookup](https://nodejs.org/api/dns.html#dnslookuphostname-options-callback).
