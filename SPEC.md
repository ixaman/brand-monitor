ROLE
You are a senior full-stack software engineer and technical architect. Plan first, then build in small vertical slices. Do not write application code until I approve the plan. After each slice, stop, summarize what was built, how to run and test it, and wait for my go-ahead.

PRODUCT
A brand/keyword mention monitoring dashboard for an online-reputation team. I add CLIENTS, save KEYWORDS under each client, and the app continuously collects mentions of them. I select a client and see every mention found. The workflow it replaces: manually searching Google for a client/keyword, filtering to the last 24 hours, and manually opening ~100 small news sites from an Excel sheet to look for mentions.

THE SYSTEM HAS THREE PARTS (keep responsibilities strictly separated)
1. WEB APP + BACKEND (the brain): stores everything, creates scan jobs, applies ALL business logic (24-hour filter, keyword matching, date parsing, deduplication), serves the dashboard.
2. SERVER WORKER (always on): scans watched news sites via RSS, sitemaps, and plain HTML; fetches and extracts articles. Needs no browser.
3. CHROME EXTENSION (the hands): runs inside the user's own logged-in Chrome, performs search-engine and site: searches and JavaScript-heavy page scans that a server cannot do reliably, and reports RAW results back. It contains NO business logic.

HARD REQUIREMENT: LAST 24 HOURS ONLY
- The primary view shows ONLY articles/posts PUBLISHED within the last 24 hours (rolling window, based on the article's own publish time, not when we found it).
- Anything older than 24 hours must be excluded from the main results, even if just discovered.
- Late indexing must not cause misses: an article published 5 hours ago but only discovered now still qualifies. Store both published_at and discovered_at, and filter on published_at.
- If the publish date cannot be parsed reliably, do NOT mix the item into the main view. Put it in a separate "Date unverified" queue for manual review.
- Default timezone: Asia/Dhaka (UTC+6), configurable. Store UTC, display local.
- Older mentions may be kept in the database for history, but they must be hidden behind an explicit "show older" control, off by default.

SOURCES (three collection engines, all feeding ONE deduplicated mentions database)
A) WATCHED SITES (build first, highest value): ~100 small news sites, mostly Bangladeshi news portals, imported from Excel/CSV. Scan each site directly on a schedule instead of relying on search engines. For each site, auto-detect the best method in this order and store it: RSS/Atom feed, XML sitemap (incl. news sitemap), listing-page crawl (homepage/section pages, configurable scan depth), site search (?s=) as a last resort. Sites that need a real browser (JavaScript-rendered or bot-protected) are flagged method="extension" and scanned by the Chrome extension. Fetch each new article, extract main text, match keywords in BOTH title and body.
B) SEARCH ENGINES: Google, Bing, DuckDuckGo, Brave. NO paid APIs. Executed by the Chrome extension in the user's own logged-in browser. Never store or transmit users' Google/Bing passwords.
C) SOCIAL via site: operator searches, executed by the extension, e.g. site:facebook.com "keyword", site:linkedin.com, site:x.com, site:instagram.com, site:youtube.com. Only publicly indexed content is expected. Query templates are configurable in the database.

=====================================================================
CHROME EXTENSION SPECIFICATION (read carefully, this is a core component)
=====================================================================
PURPOSE
The extension lets the app "borrow" the user's real, logged-in browser to run searches and page scans, because servers get blocked by search engines. It is a worker, not an application: it fetches jobs, executes them, and returns raw results.

WHAT THE EXTENSION DOES
1. Pairing: user clicks the extension icon, signs in or pastes a one-time pairing code from the dashboard's "Connect extension" page. The backend returns a long-lived per-device token stored in chrome.storage. Each device is registered in extension_devices and can be revoked from the dashboard.
2. Polling: on a schedule it asks the backend for pending jobs. IMPORTANT (Manifest V3): the background service worker is suspended by Chrome, so use chrome.alarms (not setInterval) for polling, and keep state in chrome.storage, not in memory.
3. Job leasing: when the extension claims a job, the backend marks it "leased" with an expiry (e.g. 5 minutes). If the extension does not report back in time, the job returns to the queue. Jobs must be idempotent.
4. Execution: for each job, open the target URL in a background tab (not focused), apply the time filter where the engine supports it, wait for load, run the engine-specific parser, optionally paginate to the next result pages up to the job's max_pages, then close the tab.
5. Reporting: POST the raw results to the backend, then wait a random human-like delay before the next job.
6. Status UI (popup): connected/not connected and as which user; jobs done today; jobs waiting; last successful scan time; current warnings; pause/resume button.

WHAT THE EXTENSION MUST NOT DO
- No business logic: it does NOT decide what is a mention, does NOT filter by date, does NOT deduplicate, does NOT match keywords. It sends raw results only. This way rules can change without re-installing the extension.
- It must NOT read or send the user's passwords, cookies, email, other tabs, or browsing history.
- It must NOT run arbitrary remote code. Manifest V3 forbids remotely hosted code, so parsers ship inside the extension. The backend may send only DATA (job definitions, config such as polling interval or caps), never executable code.

JOB FORMAT (backend to extension), example
{ "job_id": "...", "type": "search", "engine": "bing|google|duckduckgo|brave", "query": "\"Client X\" OR \"alias\"", "time_range": "24h", "max_pages": 2, "lease_expires_at": "..." }
{ "job_id": "...", "type": "site_scan", "url": "https://example.com/news", "max_links": 80 }
{ "job_id": "...", "type": "social_search", "engine": "google", "query": "site:facebook.com \"Client X\"", "time_range": "24h", "max_pages": 1 }

RESULT FORMAT (extension to backend), example
{ "job_id": "...", "status": "ok|blocked|error|empty", "engine": "...", "results": [ { "title": "...", "url": "...", "snippet": "...", "displayed_date": "raw text as shown, if any", "position": 1, "page": 1 } ], "error": null, "extension_version": "1.0.0" }
Important: "blocked" (CAPTCHA, unusual-traffic page, consent wall) and "empty" (genuinely no results) are DIFFERENT statuses. A blocked scan must never be recorded as "no mentions".

API ENDPOINTS TO DESIGN (extension side)
POST /api/extension/pair; GET /api/extension/jobs/next (claims and leases a job); POST /api/extension/jobs/:id/result; POST /api/extension/heartbeat (last_seen, version, paused state, current warnings). All authenticated with the per-device token, rate limited.

ANTI-BLOCK BEHAVIOR
Random delays between jobs, hard per-engine hourly caps (configurable from backend), no parallel searches on the same engine, detect CAPTCHA/block/consent pages and pause that engine for a configurable cool-down while reporting status "blocked". Surface a visible warning in popup and dashboard.

PARSERS
Each engine has its own parser module (google, bing, duckduckgo, brave, generic-listing-page), with a parser_version reported in every result. Parsers are expected to break when engines change layout, so: unit-test them against saved HTML fixtures, and have the backend raise an alert when a normally productive engine suddenly returns zero parsed results (likely parser breakage).

PERMISSIONS (keep minimal)
Host permissions limited to the search engine domains and the app's own domain; plus "alarms", "storage", "tabs" (for background tabs), "scripting". Site scans of arbitrary news portals should use optional host permissions requested per site, or an equally narrow approach. Explain the permission choices in the README.

LIMITS TO DOCUMENT
Searches only run while Chrome is open. For 24/7 coverage the extension can run on an always-on machine/VPS. Server-side RSS/sitemap scanning does not depend on the extension and keeps running when the browser is closed.

DISTRIBUTION
Internal use: load unpacked in developer mode, or publish unlisted. No public store listing needed for v1.

DASHBOARD INTEGRATION
"Connect extension" page (pairing code, device list, revoke). Per-user status "Extension online, last seen N minutes ago". "Scan now" button on a client creates jobs; the extension picks them up within seconds. Warning banner if no extension heartbeat for more than X hours.

DATA FLOW
Dashboard creates jobs, extension claims jobs, extension returns raw results, backend canonicalizes URLs, fetches article, extracts text and publish date, applies the 24-hour rule, matches keywords (title + body), deduplicates, stores the mention, dashboard reads it.
=====================================================================

BANGLA / BANGLADESH-SPECIFIC REQUIREMENTS
- Keywords support aliases: Bangla spelling, English spelling, alternate transliterations. Any alias match counts.
- Normalize Unicode (NFC plus cleanup of zero-width characters and equivalent Bangla character forms) for article text and keywords before matching.
- Date parser must handle Bangla digits (০-৯), Bangla month names, and relative times (e.g. "২ ঘণ্টা আগে", "2 hours ago"), plus ISO dates, OpenGraph/JSON-LD datePublished, and <time> tags. Prefer structured metadata over visible text.
- Detect legacy non-Unicode (Bijoy-style) garbled text and flag that site as "encoding problem" rather than reporting no mentions.
- Aggressive URL canonicalization (strip utm_*, fbclid, gclid, trailing slashes, fragments; resolve amp/mobile variants; honor rel=canonical).
- Near-duplicate clustering for syndicated stories (content hash plus title similarity) so the dashboard shows one story with "also on N sites".

DEDUPLICATION
Unique constraint on canonical_url. Cross-source merge: if the same article is found by site scan, Google, and Bing, store one record with found_by[]. Store each article once; match it against all active keywords of all clients.

DATA MODEL (refine as needed)
clients; keywords (client_id, term, aliases[], match_type exact/any/boolean, exclusions[], active); watched_sites (name, url, method rss|sitemap|listing|extension, feed_url, listing_url, scan_depth, frequency, language, active, last_scanned_at, last_new_posts, last_error); search_templates; scan_jobs (type, payload, status queued|leased|done|failed, leased_to_device, lease_expires_at, attempts); articles (canonical_url unique, title, body_text, published_at, discovered_at, date_confidence, site_id, content_hash, cluster_id); mentions (article_id, client_id, keyword_id, matched_excerpt, matched_in title|body, source, found_by[], status new|reviewed|flagged|ignored); scan_runs (target, started, finished, result_count, status ok|empty|blocked|error); extension_devices (user_id, token_hash, last_seen, version, paused, revoked).

DASHBOARD
- Client selector at top; everything scoped to the selected client.
- Mentions feed (last 24h by default): title, site, published time, matched excerpt with keyword highlighted, source badge, status.
- Filters: source type, site, keyword, status, language. Quick toggle: last 6h / 12h / 24h only (never beyond 24h unless "show older" is enabled).
- Tabs: New | All (24h) | Flagged | Date unverified | Sites health | Scan history | Extension.
- Actions: mark reviewed, flag, ignore, bulk actions, open original, copy link, export CSV of the current view.
- Health banners: site returned zero links repeatedly, engine blocked, extension offline, encoding problem, parser possibly broken. Silent failure is the biggest risk, so surface it.
- Site management: Excel/CSV import, add-site form with auto-detect preview showing the posts it found before saving.

TECH STACK (propose alternatives only if clearly better)
Next.js + TypeScript + Tailwind + shadcn/ui; PostgreSQL (with pg_trgm); BullMQ + Redis (or Inngest/Trigger.dev); always-on Node worker service for RSS/sitemap/HTML scanning and article extraction; Playwright only as a server-side fallback; Chrome extension (Manifest V3, TypeScript); per-user auth and per-device extension tokens. Isolate every connector behind a common SourceConnector interface returning normalized results {title, url, snippet, published_at, engine, position}, so any connector can be replaced without touching the rest of the app.

NON-FUNCTIONAL
Scan each article once, not per client. Rate limit per domain and per engine. Retries with exponential backoff. Structured logging. Environment-based config. Seed data and a README. Automated tests are mandatory for: URL canonicalization, Bangla Unicode normalization and keyword matching, Bangla/relative date parsing, the 24-hour window logic (boundary cases and timezone), deduplication, job leasing/expiry, and each extension parser (against saved HTML fixtures). Use real sample HTML from Bangladeshi news portals as fixtures where possible.

BUILD ORDER (stop after each slice for my review)
0. Repo setup, AGENTS.md (stack, conventions, rules), docs folder, DB schema and migrations, auth
1. Clients and keywords CRUD (aliases, exclusions)
2. Watched sites: CSV import, add-site form, auto-detect with preview
3. Server site scanner: RSS + sitemap workers, article fetch/extract, Bangla normalization, date parsing, 24h filter, matching, dedup, storage
4. Mentions dashboard with 24h default, filters, highlighting, status workflow, Date-unverified tab
5. Scheduler, scan_runs, health detection and banners
6. Job system and extension API: scan_jobs table, leasing, pairing, heartbeat, "Connect extension" dashboard page
7. Chrome extension v1: pairing, alarms-based polling, job execution in background tabs, result reporting, popup UI, listing-page scans for JS-heavy sites
8. Search-engine parsers in the extension: Bing and DuckDuckGo first, Google last, then site: social templates; block/CAPTCHA detection and cool-downs
9. Near-duplicate clustering, alerts (email/Telegram), CSV export, daily rolling re-scan for late-indexed items

KNOWN RISKS TO ADDRESS IN THE PLAN
Search-engine scraping violates engine terms and is fragile (isolate it). Social coverage via site: is partial. Extension scans depend on an open browser. MV3 service workers sleep, so design for stateless wake-ups. Parsers need ongoing maintenance, so health monitoring is essential. Short or common brand names cause false positives, so support exact phrases and exclusions.

FIRST DELIVERABLE
Do not write code yet. Return: (1) a refined architecture and any changes you recommend with reasons, (2) the full SQL schema, (3) the AGENTS.md content, (4) the extension design: manifest permissions, message flow, API contract, and failure handling, (5) a list of open questions. Wait for my approval before starting slice 0.
