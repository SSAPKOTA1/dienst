# Data protection impact assessment (Art. 35 GDPR) - TEMPLATE

Whether a DPIA is mandatory depends on the circumstances (systematic monitoring of employees can be a reason; check the supervisory authority's list). This template documents the assessment either way. [Controller to confirm and sign.]

## 1. Description
Workforce scheduling and time recording for hotels (see `VVT-template.md`). No biometrics, no location tracking, no performance scoring or ranking of people, no wage data, no automated decisions with legal effect: planners decide, the rules engine only reports violations.

## 2. Necessity and proportionality
- Working-time records are a legal duty (ArbZG §16 (2)). Scheduling and absence management are needed to run the contract.
- Data minimisation: date of birth only for minor protection; optional contact data; displayed names are shortened ("Maria G.") in team views; managers see reduced views of people from other hotels; phone numbers only if the company allows it.
- Storage limitation: anonymisation after the retention period (job), documents deleted at anonymisation.

## 3. Risks and measures
| Risk | Likelihood / severity [rate] | Measures built in | Residual [rate] |
| --- | --- | --- | --- |
| Unauthorised access by staff to colleagues' data | | Scope filtering on every query, reduced views, access log of record views, per-person transparency log | |
| Misuse of time data for performance control | | No scoring or ranking features, no wage fields, purpose bound documentation [works agreement] | |
| Account takeover | | argon2id, rate limits, lockout, mandatory 2FA for administrators, secure cookies, session revocation | |
| Data loss or leak at hosting or backup | | Encrypted documents, optional encrypted backups, restore drill, [hosting processor agreement] | |
| Data kept longer than needed | | Retention setting, daily anonymisation job, manual anonymisation endpoint | |
| Subject cannot exercise rights | | Self-service export, admin export, anonymisation, process in `DATA-SUBJECT-REQUESTS.md` | |
| Tampering with records | | Tamper-evident audit chains with verification, period close and approvals | |

## 4. Consultation
[Works council / employee representatives, data protection officer opinion, date.]

## 5. Decision and review
[Approved by, date, next review date (at least yearly or on major change).]
