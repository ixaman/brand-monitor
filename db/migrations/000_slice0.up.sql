CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA monitor;
CREATE TABLE monitor."user" (
 id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 "emailVerified" boolean NOT NULL DEFAULT false, image text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE monitor.session (
 id text PRIMARY KEY, "userId" text NOT NULL REFERENCES monitor."user"(id) ON DELETE CASCADE,
 token text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 "ipAddress" text, "userAgent" text,
 CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX session_user_idx ON monitor.session("userId");
CREATE TABLE monitor.account (
 id text PRIMARY KEY, "userId" text NOT NULL REFERENCES monitor."user"(id) ON DELETE CASCADE,
 "accountId" text NOT NULL, "providerId" text NOT NULL CHECK ("providerId" = 'google'),
 "accessToken" text, "refreshToken" text, "idToken" text,
 "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
 scope text, password text CHECK (password IS NULL),
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("providerId", "accountId"),
 CHECK ("accessToken" IS NULL AND "refreshToken" IS NULL AND "idToken" IS NULL)
);
CREATE INDEX account_user_idx ON monitor.account("userId");
CREATE TABLE monitor.verification (
 id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
 "expiresAt" timestamptz NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON monitor.verification(identifier);
CREATE TABLE monitor.app_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email LIKE '%@%'),
 role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','analyst','viewer')),
 state text NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','active','disabled')),
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (state <> 'active' OR approved_at IS NOT NULL)
);
REVOKE ALL ON SCHEMA monitor FROM PUBLIC;
