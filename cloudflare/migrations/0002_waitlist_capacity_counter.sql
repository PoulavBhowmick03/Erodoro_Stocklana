DROP TRIGGER waitlist_capacity;

CREATE TABLE waitlist_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0 AND entry_count <= 100000)
);

INSERT INTO waitlist_state (id, entry_count)
SELECT 1, COUNT(*) FROM waitlist_entries;

CREATE TRIGGER waitlist_capacity
BEFORE INSERT ON waitlist_entries
WHEN (SELECT entry_count FROM waitlist_state WHERE id = 1) >= 100000
BEGIN
  SELECT RAISE(ABORT, 'WAITLIST_FULL');
END;

CREATE TRIGGER waitlist_increment
AFTER INSERT ON waitlist_entries
BEGIN
  UPDATE waitlist_state SET entry_count = entry_count + 1 WHERE id = 1;
END;

CREATE TRIGGER waitlist_decrement
AFTER DELETE ON waitlist_entries
BEGIN
  UPDATE waitlist_state SET entry_count = entry_count - 1 WHERE id = 1;
END;
