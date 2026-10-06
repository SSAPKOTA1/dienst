-- Soft or hard per configurable planning restriction, kept with the company or hotel rule profile.
-- Example: {"ABSENCE_CONFLICT":"soft","DAILY_OVER_8H":"hard"}; a restriction that is not listed keeps its default.
ALTER TABLE rule_profile ADD COLUMN severities JSONB NOT NULL DEFAULT '{}'::jsonb;
