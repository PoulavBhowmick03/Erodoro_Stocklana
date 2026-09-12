CREATE TABLE IF NOT EXISTS waitlist_entries (
  email_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  joined_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS waitlist_capacity
BEFORE INSERT ON waitlist_entries
WHEN (SELECT COUNT(*) FROM waitlist_entries) >= 100000
BEGIN
  SELECT RAISE(ABORT, 'WAITLIST_FULL');
END;
