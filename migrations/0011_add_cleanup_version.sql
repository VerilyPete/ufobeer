-- cleanup_version records which version of the deterministic cleanup rules
-- produced brew_description_cleaned (CLEANUP_VERSION in src/constants.ts).
-- NULL means legacy cleanup (Workers AI or earlier rules). The admin cleanup
-- trigger's mode 'all' re-cleans every row older than the current version.

-- NOT IDEMPOTENT: relies on migration tracking to prevent re-runs
ALTER TABLE enriched_beers ADD COLUMN cleanup_version INTEGER;
