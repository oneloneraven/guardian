ALTER TABLE results ADD COLUMN unknown_sweeps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN claimed_at TEXT;
ALTER TABLE security_events ADD COLUMN delivery TEXT;
CREATE UNIQUE INDEX security_events_delivery ON security_events (delivery) WHERE delivery IS NOT NULL;

CREATE TABLE results_next (
  target TEXT NOT NULL,
  check_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unknown', 'skipped')),
  reason TEXT,
  link TEXT,
  previous_status TEXT CHECK (previous_status IN ('pass', 'fail', 'unknown', 'skipped')),
  checked_at TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL CHECK (changed_by IN ('event', 'sweep', 'daily')),
  unknown_sweeps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (target, check_id)
);

INSERT INTO results_next SELECT target, check_id, status, reason, link, previous_status, checked_at, changed_at, changed_by, unknown_sweeps FROM results;
DROP TABLE results;
ALTER TABLE results_next RENAME TO results;
