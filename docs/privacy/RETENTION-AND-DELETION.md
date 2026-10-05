# Retention and deletion

| Data | Kept | Then |
| --- | --- | --- |
| Working-time records (punches, schedule, absences, time account, contracts) | Contract end + `company.retention_months` (default 36, never below 24; ArbZG §16 (2) requires 2 years, the extra year covers the regular limitation period of claims, §195 BGB) | Person is anonymised; hour records stay without a name |
| Profile (name, birth date, contact, badge, PIN) | Same | Name becomes "Gelöscht", birth date reduced to the year, contact data and badge removed |
| Login account | Same | E-mail and username removed, password and 2FA secret removed, account disabled, sessions and SSO links deleted (only if the account is not used by another role or employment) |
| Documents, notifications, wishes, availability, questions to management, calendar feeds, vacation notices, announcement acknowledgements | Same | Deleted |
| Team feed posts and comments | Until deleted by moderators | Author shown as "Gelöscht" |
| Audit log | [operator decides, suggestion: 3 years] | The audit log is append-only and hash chained; it holds ids, actions and changed values. It is not rewritten when a person is anonymised. If the operator must purge old entries, do it as a documented, whole-period archive and keep the chain heads. |
| Backups | [rotation set by the operator, see `docs/RUNBOOK.md`] | Backups age out; an anonymised person can reappear after a restore until the job runs again (the daily job re-applies it) |

Tax-relevant payroll records are not stored in this app.

## How it runs
- Daily at about 03:00 UTC the job `retention` anonymises everybody whose contract ended before `retention_months` ago and who is not active. It is idempotent and writes an audit entry per person (`employee_anonymised`, reason `retention`).
- Administrators can anonymise one person with `POST /employees/:id/anonymise` once the retention period is over. Earlier requests are answered with `409 CONFLICT`, `details.code = RETENTION_ACTIVE` and `details.eligibleFrom`.
- Employees who are still employed cannot be anonymised (`STILL_EMPLOYED`).
