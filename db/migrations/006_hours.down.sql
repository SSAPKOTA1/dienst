ALTER TABLE hotel DROP COLUMN IF EXISTS rule_profile_id;
ALTER TABLE company DROP COLUMN IF EXISTS rule_profile_id;
DROP TABLE IF EXISTS company_feature, rule_profile, punch_record_category_minutes, hour_category, arbeitszeitkonto_entry;
