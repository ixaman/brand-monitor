# Slice 3: article processing

## Run

Run `pnpm db:migrate`, then `pnpm worker:dev`. The worker detects saved sites and consumes their saved preview links. `pnpm worker:scan` refreshes active RSS/Atom and XML/news sitemap endpoints plus each active site’s supplied listing pages once and drains the durable article queue. Its summary includes each site's errors; it exits successfully if any site succeeds (or no sites are eligible), and fails if all attempted sites fail. Historical candidate errors do not determine the exit code. `pnpm worker:scan --site <watched-site UUID>` limits endpoint refresh to that site; shared article processing still covers all queued sites. These operator commands use restricted `DATABASE_URL` credentials. No collection scheduler is installed in this slice.

`pnpm worker:scan --retry-errors` explicitly retries failed candidates. `pnpm worker:rematch` reevaluates stored article text against current active keywords, preserving each client's review state. After a rule edit, obsolete revision evidence is immediately excluded from current reads until rematching completes.

`SITE_REQUEST_DELAY_MS` defaults to 1000; `ARTICLE_TIMEOUT_MS` defaults to 15000. PostgreSQL advisory locks serialize publisher-host aliases across processes, including detection and every redirect hop, and remain held during the inter-request gap. Each request validates public DNS and pins the validated address to its socket. Redirects, response reads (first 5 MiB; larger bodies are truncated), sitemap nesting (2), endpoint requests (20), and discovery count (1000) are bounded. Large sitemaps retain the newest 1000 entries by publication date, using `lastmod` only for fallback ordering. News sitemaps take priority; index children are read newest-modified first. Sitemap coverage limits are recorded in site detection diagnostics instead of failing the site. RSS and sitemap depth cap failures remain errors. Listing scans fetch the Listing URL and additional listing URLs on every scan, including sites with method `listing`, and follow same-host section/pagination links up to scan depth 0–2 and 20 listing requests. Navigation, category, tag, archive, print, homepage and search URLs never enter article work; known listing URLs are skipped. Publication evidence orders candidates before newest discovery time; each site adds at most 100 new URL identities per scan across its sources. Feeds/sitemaps with no entry dated within seven days are diagnosed as stale and yield to supplied listings. Sitemap `lastmod` may establish source freshness but never article publication. Scan diagnostics are replaced on each successful scan so recovered sources lose their stale scan warning. Fetch errors remain explicit failed candidates; automatic retries and scheduling belong to slice 5.

## Files changed

- `packages/domain/src/article-{collection,dates,extraction,matching,store,urls}.ts`, `polite-http.ts`, `safe-http.ts`, `keywords.ts`, `index.ts`: collection, extraction, shared rules, transactional persistence and safe requests.
- `apps/worker/src/index.ts`, `scripts/scan.ts`, `scripts/check-samples.ts`: preview consumption, manual source refresh/rematching and sample verification.
- `db/migrations/003_slice3.up.sql` and `.down.sql`: only the five slice 3 tables.
- `tests/article-{collection,dates,extraction,matching,urls}.test.ts`, `tests/real-samples.test.ts`, `tests/integration/slice3.test.ts`, `tests/integration/article-merge.test.ts`: rule/fixture/storage regressions; `tests/integration/slice2.test.ts` accounts for the later migration during its rollback test.
- `.env.example`, `package.json`, `scripts/web.mjs`, `README.md`, this document: configuration, run/test/build commands and notes. Next.js regenerated `apps/web/next-env.d.ts` during the production build. The user's existing ignore rule for private captures was preserved.

## Storage and rules

Only five tables are introduced by `003_slice3`: `articles`, `article_urls`, `article_candidates`, `mentions`, `mention_matches`. Candidates are durable discoveries and provenance, unique per site, normalized URL and source. Original fetch URLs are retained independently of canonical identities. Earliest discovery and immutable date-observation clocks are retained. No extension/job/run/settings/review/cluster tables are created.

The worker serializes article processing across processes. It fetches an unknown URL identity once and matches extracted content against all active keywords of all active clients. Known aliases use stored bodies. Unseen aliases may need a fetch to discover their canonical identity; converging identities are merged transactionally, including provenance, keyword evidence and client review state. Each canonical article is stored once, with one workflow mention per client and per-keyword title/body evidence. Tracking parameters/fragments/slashes and conventional AMP/mobile forms are normalized; content-ID parameters and path case remain. Publisher canonicals must stay within recognized publisher host aliases; incorrect homepage canonicals on article pages are ignored.

Title/body extraction removes navigation, related stories, sharing controls and promotions while retaining full main text. Incomplete, blocked and suspected legacy-encoding pages have explicit diagnostics and create no confirmed matches. Legacy detection is a conservative heuristic, not a Bijoy converter. Raw and normalized text plus original UTF-16 match offsets are stored.

Publication evidence preference is JSON-LD Article `datePublished`, OpenGraph publication metadata, publication `<time>` fields, RSS/Atom/news-sitemap publication fields, then publication-labelled visible text. `dateModified`, Atom `updated`, and generic sitemap `lastmod` never establish publication. Parsing supports Bangla digits/Gregorian month names, ISO/RFC feed dates, English/Bangla relative times, explicit offsets/named timezones and site timezone assumptions (default Asia/Dhaka). Relative labels retain their original observation clock. Malformed, conflicting or ambiguous evidence remains date unverified; source, raw value, parsed bounds and timezone assumptions are retained.

UTC timestamps retain microsecond precision. Date-only/minute-only/relative labels have conservative bounds. The authorized `readCurrentMentions` domain query checks active clients/keywords/current revisions and complete readable text. Verified articles qualify when the entire publication interval lies within `[statement time − 24h, statement time]`; date-unverified articles qualify when their earliest discovery lies within that window and always carry the "Date not verified" flag. Coarse publication intervals straddling the window's lower cutoff remain uncertain for that view and can use the same discovery fallback. Exactly 24h is included; one microsecond older is excluded by the applicable publication/discovery clock. Fully old or future verified publications cannot qualify through discovery. Eligibility expires at query time without an `is_recent` flag. Rediscovery retains the first clock; the discovery fallback never changes date confidence, while new trusted publication evidence may verify an uncertain date. Older matches stay stored for explicit history, and Date unverified retains all unresolved dates.

Normalization shares NFC and zero-width cleanup between keywords and articles, preserving Bangla marks and equivalent nukta forms. Exact rules use Unicode word/phrase boundaries; any rules use literal substrings. Aliases replace the primary term's Boolean literal alternatives while AND/NOT constraints remain in force. Exclusions in either title or body veto a rule. Boolean NOT-only success without positive literal evidence cannot create a mention. Each keyword stores one excerpt per matching field.

## Test

Run `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and `pnpm build`. Integration files run serially to avoid concurrent changes to PostgreSQL's cluster-wide runtime role; tests explicitly exercise concurrent article processing, canonical convergence, host locking, recovery, provenance, current-read exclusion, rematching and migration rollback inside disposable databases. Synthetic fixtures exercise dates, normalization, matching, canonical URLs, collector limits and extraction errors. `pnpm samples:check` checks top-level private captures without fetching their assets; optional fixture tests explicitly skip if those ignored captures are absent.

## Private sample results

Checked the saved captures on 11 October 2026 at approximately 23:02 Asia/Dhaka (17:02 UTC). All four titles and main bodies extracted successfully. Character counts are JavaScript UTF-16 lengths; timestamps below are UTC.

| Saved article | Main text | Publication result | Evidence |
| --- | ---: | --- | --- |
| Bangladesh’s Rooppur plant achieves first controlled nuclear reaction | 5,452 characters, 37 blocks | 2026-10-11 14:41:07 UTC; verified, current at check time | JSON-LD and OpenGraph agree; Dhaka visible time agrees |
| চুরি যাওয়া ল্যাপটপের অবস্থান জানালেন জার্মান পর্যটক, তবু কেন উদ্ধার হচ্ছে না | 3,731 characters, 21 blocks | 2026-10-11 16:13:22 UTC; verified, current at check time | `<time datetime>` with +06:00; Bangla visible date agrees |
| রিয়াদ বিমানবন্দরে আবার হামলা, টার্মিনালে আগুন | 1,651 characters, 8 blocks | 2026-10-11 15:53:59 UTC; verified, current at check time | `<time datetime>` with +06:00; Bangla visible date agrees |
| ‘অল-রাউন্ড ডিউরেবল চ্যাম্পিয়ন’ রিয়েলমি সি১০০ উন্মোচন | 2,797 characters, 8 blocks | Date unverified; current reads require first discovery within the window and the "Date not verified" flag | Only `10/08/2026`; day/month order is ambiguous, no trustworthy publication metadata |

Prothom Alo's saved pages claim the homepage as canonical; this incorrect claim was ignored and each story retained its own identity. Private HTML and asset folders remain ignored. The sample command prints extracted title, canonical URL, text counts, date evidence and diagnostics for every supplied page.

## Limits and rollback

Live fetching of all configured publishers, bot-protected/JavaScript-rendered sites and legacy-font conversion remain unverified. Ambiguous numeric dates/timezone abbreviations, unknown relative labels and non-Gregorian calendar month names remain unverified. Three saved samples verify extraction and date rules; they do not establish ongoing live publisher availability.

On a disposable database, `pnpm db:rollback` removes only slice 3 tables; sites, endpoints, clients, keywords and auth remain. `pnpm db:migrate` recreates empty slice 3 tables. Further rollbacks remove earlier slices in reverse order.
