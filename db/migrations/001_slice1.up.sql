CREATE TABLE monitor.clients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK (btrim(name) <> ''), notes text NOT NULL DEFAULT '',
 active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES monitor.app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clients_active_name_idx ON monitor.clients(active, name);
CREATE TABLE monitor.keywords (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id uuid NOT NULL REFERENCES monitor.clients(id) ON DELETE CASCADE,
 term text NOT NULL CHECK (btrim(term) <> ''),
 aliases text[] NOT NULL DEFAULT '{}', exclusions text[] NOT NULL DEFAULT '{}',
 match_type text NOT NULL DEFAULT 'exact' CHECK (match_type IN ('exact','any','boolean')),
 boolean_ast jsonb,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES monitor.app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (array_position(aliases, NULL) IS NULL AND array_position(exclusions, NULL) IS NULL),
 CHECK ((match_type = 'boolean' AND boolean_ast IS NOT NULL AND jsonb_typeof(boolean_ast) = 'object') OR (match_type <> 'boolean' AND boolean_ast IS NULL))
);
CREATE INDEX keywords_client_active_idx ON monitor.keywords(client_id, active);
