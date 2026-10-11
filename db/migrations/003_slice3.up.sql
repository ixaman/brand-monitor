CREATE TABLE monitor.articles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 canonical_url text NOT NULL UNIQUE CHECK (canonical_url ~ '^https?://'),
 title text NOT NULL, body_text text NOT NULL,
 normalized_title text NOT NULL, normalized_body text NOT NULL,
 published_at timestamptz, publication_lower timestamptz, publication_upper timestamptz,
 discovered_at timestamptz NOT NULL,
 date_confidence text NOT NULL CHECK (date_confidence IN ('verified','unverified')),
 date_precision text, date_reason text, date_evidence jsonb NOT NULL DEFAULT '[]',
 source_timezone text NOT NULL,
 extraction_status text NOT NULL CHECK (extraction_status IN ('extracted','encoding_problem','extraction_failed','blocked')),
 extraction_reason text,
 site_id uuid REFERENCES monitor.watched_sites(id) ON DELETE SET NULL,
 content_hash text NOT NULL,
 parser_version text NOT NULL DEFAULT 'slice3-v1',
 CHECK (date_confidence <> 'verified' OR (published_at IS NOT NULL AND publication_lower IS NOT NULL AND publication_upper IS NOT NULL)),
 CHECK (publication_lower <= publication_upper),
 CHECK (date_confidence = 'unverified' OR published_at BETWEEN publication_lower AND publication_upper)
);
CREATE INDEX articles_publication_idx ON monitor.articles(published_at) WHERE date_confidence='verified' AND extraction_status='extracted';
CREATE TABLE monitor.article_urls (
 url text PRIMARY KEY CHECK (url ~ '^https?://'),
 article_id uuid NOT NULL REFERENCES monitor.articles(id) ON DELETE CASCADE
);
CREATE INDEX article_urls_article_idx ON monitor.article_urls(article_id);
-- Durable discoveries also retain provenance; these are article work, not slice 6 extension jobs.
CREATE TABLE monitor.article_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 site_id uuid NOT NULL REFERENCES monitor.watched_sites(id) ON DELETE CASCADE,
 url text NOT NULL CHECK (url ~ '^https?://'),
 fetch_url text NOT NULL CHECK (fetch_url ~ '^https?://'),
 source text NOT NULL CHECK (source IN ('rss','sitemap','listing')),
 discovered_at timestamptz NOT NULL,
 date_evidence jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','error')),
 error text,
 article_id uuid REFERENCES monitor.articles(id) ON DELETE SET NULL,
 UNIQUE(site_id,url,source)
);
CREATE INDEX article_candidates_queue_idx ON monitor.article_candidates(discovered_at,id) WHERE status IN ('queued','processing');
CREATE TABLE monitor.mentions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 article_id uuid NOT NULL REFERENCES monitor.articles(id) ON DELETE CASCADE,
 client_id uuid NOT NULL REFERENCES monitor.clients(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','flagged','ignored')),
 UNIQUE(article_id,client_id)
);
CREATE TABLE monitor.mention_matches (
 mention_id uuid NOT NULL REFERENCES monitor.mentions(id) ON DELETE CASCADE,
 keyword_id uuid NOT NULL REFERENCES monitor.keywords(id) ON DELETE CASCADE,
 keyword_revision integer NOT NULL CHECK (keyword_revision>0),
 matched_in text NOT NULL CHECK (matched_in IN ('title','body')),
 matched_term text NOT NULL, matched_excerpt text NOT NULL,
 match_start integer NOT NULL CHECK (match_start>=0), match_end integer NOT NULL,
 matcher_version text NOT NULL DEFAULT 'slice3-v1',
 PRIMARY KEY(mention_id,keyword_id,matched_in),
 CHECK (match_end>match_start)
);
