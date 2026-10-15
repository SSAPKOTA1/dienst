-- Flexible hours: what happens with hours above the target. 'account' keeps them in the time account (Arbeitszeitkonto),
-- 'payout' marks them as paid out each month (payroll pays them; the app stores no wages). Set per contract version;
-- the hotel only provides the default for new employees.
ALTER TABLE employee_contract
  ADD COLUMN overtime_mode VARCHAR(10) NOT NULL DEFAULT 'account' CHECK (overtime_mode IN ('account', 'payout'));
ALTER TABLE hotel
  ADD COLUMN default_overtime_mode VARCHAR(10) NOT NULL DEFAULT 'account' CHECK (default_overtime_mode IN ('account', 'payout'));
