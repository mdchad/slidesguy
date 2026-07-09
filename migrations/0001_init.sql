CREATE TABLE jobs (
  job_id          TEXT PRIMARY KEY,
  presentation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  total_slides    INTEGER,            -- NULL until plan step completes
  status          TEXT NOT NULL,      -- queued | processing | done | failed
  failed_step     TEXT,               -- e.g. 'plan', 'slides-00-09', 'assemble'
  error_msg       TEXT,               -- truncated to 1000 chars
  created_at      INTEGER NOT NULL,   -- unix ms
  finished_at     INTEGER
);
CREATE INDEX idx_jobs_user ON jobs(user_id, created_at DESC);
