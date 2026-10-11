CREATE TABLE monitor.watched_sites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK (btrim(name) <> ''),
 url text NOT NULL UNIQUE CHECK (url ~ '^https?://'),
 listing_url text CHECK (listing_url ~ '^https?://'),
 source_timezone text NOT NULL DEFAULT 'Asia/Dhaka',
 scan_depth integer NOT NULL DEFAULT 1 CHECK (scan_depth BETWEEN 0 AND 2),
 active boolean NOT NULL DEFAULT true,
 method text NOT NULL DEFAULT 'pending' CHECK (method IN ('pending','rss','sitemap','listing','extension')),
 detection_status text NOT NULL DEFAULT 'queued' CHECK (detection_status IN ('queued','detecting','ready','needs_attention')),
 detection_revision integer NOT NULL DEFAULT 1 CHECK (detection_revision > 0),
 preview jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(preview) = 'array'),
 diagnostics jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(diagnostics) = 'array'),
 detected_at timestamptz,
 detection_requested_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL REFERENCES monitor.app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watched_sites_detection_idx ON monitor.watched_sites(detection_requested_at) WHERE detection_status IN ('queued','detecting');
CREATE TABLE monitor.site_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 site_id uuid NOT NULL REFERENCES monitor.watched_sites(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('rss','sitemap','listing')),
 url text NOT NULL CHECK (url ~ '^https?://'),
 configured boolean NOT NULL DEFAULT false,
 is_primary boolean NOT NULL DEFAULT false,
 UNIQUE (site_id,kind,url)
);
CREATE UNIQUE INDEX site_endpoints_primary_idx ON monitor.site_endpoints(site_id) WHERE is_primary;
