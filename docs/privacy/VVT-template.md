# Record of processing activities (Art. 30 GDPR) - TEMPLATE

Fields in `[brackets]` must be filled in by the controller. Review with the data protection officer.

## Controller
[Company name, address, representative, contact]. Data protection officer: [name, contact or "not required, reason"].

## Processing 1: Working time recording and scheduling
| Item | Entry |
| --- | --- |
| Purpose | Planning of shifts, recording of working time (ArbZG §16), absence and vacation management (BUrlG), approvals and month close |
| Legal basis | Art. 6 (1) (b) GDPR with §26 BDSG (employment contract); Art. 6 (1) (c) for statutory recording duties; [works agreement if any] |
| Data subjects | Employees, trainees, minors (JArbSchG), planners and administrators as users |
| Data categories | Name, personnel number, date of birth (minor protection), contact data (optional), contract data (type, hours, weekdays, vacation entitlement), shifts, clock-in and clock-out times, breaks, absences (type only, no diagnosis), wishes, availability, qualifications, uploaded documents (no health data), login data, audit entries |
| Special categories | None intended. "Maternity" is a flag without detail; sickness is an absence type without diagnosis. Do not upload medical documents. |
| Recipients | Planners and administrators of the same company within their hotel scope; [hosting provider as processor]; [mail provider as processor]; [tax adviser or payroll provider if data is exported by the operator] |
| Third country transfers | [none / describe] |
| Retention | Working-time records: `company.retention_months` (default 36, minimum 24) after contract end, then anonymised; see `RETENTION-AND-DELETION.md` |
| Technical and organisational measures | See below |

## Processing 2: Kiosk time clock
Same purpose and basis as above. Data: personal PIN (hashed, never shown again), optional badge number (hashed), device token. No biometrics, no GPS. Tablets are registered per hotel; web clock-in can be limited to the hotel network.

## Processing 3: Communication
Announcements, messages to management, shift swaps, team feed. Data: content written by users, author names. Content is deleted or the author is shown as "Gelöscht" when a person is anonymised.

## Technical and organisational measures (as built)
- Access control by role and scope (company, hotel); every query is scope filtered; two-factor login mandatory for administrators.
- Encryption in transit (TLS at the proxy, HSTS), encrypted documents and 2FA secrets at rest in the database with purpose-bound keys, hashed passwords and PINs, encrypted backups (optional, `age`).
- Tamper-evident audit log with per-company hash chains and a verification endpoint; access log for personal data.
- Rate limiting, strict security headers, SSRF protection for outbound calls, dependency and secret scanning in CI.
- Backups with tested restore (`scripts/ops`), retention and anonymisation job.
- [Operator measures: physical security of hosting, staff training, confidentiality agreements, device policy.]
