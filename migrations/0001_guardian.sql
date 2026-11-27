CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE settings_audit (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  key TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1))
);

CREATE INDEX settings_audit_unnotified ON settings_audit (id) WHERE notified = 0;

CREATE TABLE standard (
  version TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  body TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE repositories (
  name TEXT PRIMARY KEY,
  expected_visibility TEXT CHECK (expected_visibility IN ('public', 'private')),
  accepted_record_sha TEXT
);

CREATE TABLE exceptions (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL,
  check_id TEXT NOT NULL,
  match TEXT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE known_tokens (
  token_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
  repository TEXT
);

CREATE TABLE results (
  target TEXT NOT NULL,
  check_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unknown')),
  reason TEXT,
  link TEXT,
  previous_status TEXT CHECK (previous_status IN ('pass', 'fail', 'unknown')),
  checked_at TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL CHECK (changed_by IN ('event', 'sweep', 'daily')),
  PRIMARY KEY (target, check_id)
);

CREATE TABLE security_events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('github', 'cloudflare')),
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  detail TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX security_events_target ON security_events (target, occurred_at);
CREATE INDEX security_events_occurred ON security_events (occurred_at);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  subject TEXT NOT NULL,
  reason TEXT,
  posted_at TEXT NOT NULL
);

CREATE INDEX alerts_subject ON alerts (kind, target, subject, posted_at);

CREATE TABLE cursors (
  name TEXT PRIMARY KEY,
  position TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
