# Administrator handbook (English)

For **administrators** of a company and **super administrators** (several companies). Technical operation (servers, backups, incidents) is in [../RUNBOOK.md](../RUNBOOK.md) and [../INFRASTRUCTURE.md](../INFRASTRUCTURE.md).

## 1. Roles

| Role | May |
|---|---|
| **Super administrator** | Create companies and hotels, switch hotels off and on, create further super administrators, assign administrators to companies or single hotels, change staff roles of any person, everything below |
| **Administrator** | The assigned companies (all their hotels) and/or single hotels: employees (profile, hotels, departments, contract), users, tablets, integrations, rules, month close, audit log, privacy. An administrator assigned to single hotels sees and edits only the employees who work at those hotels |
| **Manager** | Assigned hotels and departments only: planning, requests, live, team; no setup, no integrations |
| **Employee** | Own data in the portal and at the tablet |

Every query is limited on the server to the companies and hotels of the signed-in person. A person may hold several roles and picks one after signing in. **Administrators and super administrators must set up a second factor** (authenticator app or security key/passkey, see _Security_ in the name menu).

## 2. Setting up (in this order)

**Admin → Overview** shows a checklist with the state of the setup.

1. **Companies** (super administrator only): name, retention in months (default 36; legal minimum for working-time records is 24), invite an administrator.
2. **Hotels:** name, **time zone** (default Europe/Berlin), departments, **shift templates** (start, end, break, colour) and **required headcount** per template and weekday. The time zone drives daylight-saving maths and the day a shift belongs to (its start day). The super administrator can **deactivate** a hotel (_Admin → Hotels_): it disappears from planning, lists and the tablet, all records stay, and it can be activated again. A hotel with people still clocked in cannot be deactivated until they have clocked out.
3. **Users & roles:** invite managers and further administrators and assign hotels/departments. Invitations go by e-mail; without e-mail create an **activation code**. The super administrator can also invite **further super administrators**, give an administrator **whole companies or single hotels** and open **Change roles** for any person (also an employee): tick _Super administrator_, _Administration_ (companies and/or hotels) or _Manager_ (hotels). A person with several roles picks one at sign-in. Revoking a role takes effect immediately and keeps the history; you cannot remove your own super administrator role. A staff role needs an e-mail address.
4. **Create and edit employees:** under _Team → Staff_ one by one or with the **Excel import** (dry run, error CSV, one-time credentials sheet with passwords/PINs; store it safely and destroy it). Every person automatically gets an account and the employee role. PINs have 6 digits, are shown once and are never e-mailed. In the employee detail, **Edit** changes personal data, home hotel, further hotels and departments; **Change contract** adds a new contract version from a date (employment type, working days, target hours, vacation days); earlier periods stay unchanged. Both are logged.
5. **Tablets:** _Admin → Tablets_ → add a tablet; enter the one-time code on the device at `/kiosk`. Device tokens can be revoked. "Device not registered" means the token was revoked. Optionally assign a **badge** (QR/NFC) per person.
6. **Rules:** _Admin → Rules_ shows the legal limits (rest period, maximum working time, breaks, minors). Legal limits cannot be weakened; **rule profiles** may only be **stricter**. Switch features (wishes, swaps, open shifts, availability, announcements, feed, messages, documents, calendar feed, team calendar) on or off per company; allow web punch per hotel through its permitted network ranges. Hour categories (night, Sunday, holiday, Christmas Eve/New Year's Eve) are configurable; the system computes **minutes only, no wages**.
7. **Integrations:** read-only API keys (with expiry, scopes and optional network) and **single sign-on (OpenID Connect)**. See [../PUBLIC-API.md](../PUBLIC-API.md). Keys are shown once; rotate before expiry (notices 14 and 3 days ahead).

## 3. Daily and monthly operation

- **Requests, live, compliance:** see the user manual, sections 4–6. Plan for managers to clear open requests daily.
- **Month close:** _Admin → Overview → Month close_. Closing fails while approvals or corrections are open (the list is shown). Afterwards planning, punches, corrections and absences in that range are locked. **Reopen** only with a reason; both actions are logged. Then export hours: timesheets (PDF/Excel), payroll export (hours only), attendance CSV.
- **Background jobs:** auto-checkout, vacation carry-over, reminders, offboarding, retention. They run in a separate worker process (`RUN_JOBS`); alerts fire when they stall.

## 4. Audit log

_Admin → Audit_ lists every change (who, role, what, old/new, reason). The log is hash-chained and append-only; **Verify** proves tampering. Filter by person, action and period. Reads of personnel records, data exports and document downloads are logged as well.

## 5. Privacy in operation

Templates and processes: [../privacy/README.md](../privacy/README.md).

- **Access/export:** data export per person (employee record → data export). Answer requests within one month.
- **Erasure/anonymisation:** working-time records must be kept for at least 24 months; after the retention period a daily job anonymises. Earlier deletion is only possible for data without a retention duty; see `DATA-SUBJECT-REQUESTS.md`.
- **Operator duties:** complete the record of processing and the impact assessment, processing agreements with the host and the mail provider, works council / staff information, retention periods with your tax adviser.

## 6. Everyday security

- Lost devices: revoke the tablet token; remove the security key.
- Leavers: _Deactivate_ ends all sessions; the offboarding job anonymises after the retention period.
- Passwords min. 10 characters, five failures lock; a PIN lock lasts 15 minutes and managers can lift it.
- Suspected breach: follow the incident checklist in [../RUNBOOK.md](../RUNBOOK.md) (rotate keys, revoke API keys) and report personal-data breaches to the supervisory authority within **72 hours** (Art. 33 GDPR).

## 7. Troubleshooting

| Symptom | Cause / action |
|---|---|
| Tablet: "Device not registered" | Token revoked or wrong; create a new one under _Tablets_ |
| Web punch refused | Only allowed from the hotel network; check network ranges and `TRUST_PROXY` |
| Month close refused (`PENDING_APPROVALS`) | Clear the open approvals |
| Change refused (`PERIOD_CLOSED`) | Reopen the month (with a reason) |
| Schedule cannot be saved (`RULE_BLOCKED`) | A rule is violated; change it or use the emergency override with a reason |
| E-mails do not arrive | SMTP settings; `MAIL_MODE` must not be `json` in production |
