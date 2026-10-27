-- cleanup_limits tracked Workers AI cleanup calls. Cleanup became
-- deterministic and lost its quota (PR #46); nothing reads or writes it.
DROP TABLE IF EXISTS cleanup_limits;
