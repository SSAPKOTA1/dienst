# Privacy documents

These are **templates and technical facts**, not legal advice. The operator (the hotel company, the "controller") must fill in the marked fields, have them reviewed by a data protection officer or lawyer, and sign where needed. Nothing here replaces that.

| Document | What it is |
| --- | --- |
| `VVT-template.md` | Record of processing activities (Art. 30 GDPR), pre-filled with what the app does |
| `DPIA-template.md` | Data protection impact assessment (Art. 35), pre-filled with risks and the measures built in |
| `RETENTION-AND-DELETION.md` | What is kept how long, and how deletion works |
| `DATA-SUBJECT-REQUESTS.md` | How to answer access, export and erasure requests with the app |

## What the app does for privacy
- Personal data per person: name, date of birth, contact data, contract and working-time data, absences, wishes, qualifications, documents. No wages, no health diagnoses (sickness is only an absence type), no biometrics, no location data.
- Employee data export (`GET /me/data-export`, `GET /employees/:id/data-export`) and anonymisation (`POST /employees/:id/anonymise`, daily retention job).
- Access log: reading a person's record, exporting data, downloading documents and anonymising are written to the tamper-evident audit log. Admins see it per person; employees see when which kind of role looked at their data (`GET /me/access-log`).
- Encryption of documents and 2FA secrets with purpose-bound keys; PINs and passwords hashed (argon2id); logs free of PINs, passwords, tokens and full names.

## What the operator still has to do (the app cannot)
1. Complete and sign the record of processing and the DPIA, appoint a data protection officer if required (§38 BDSG: 20 or more people regularly processing personal data automatically).
2. Conclude a data processing agreement (Art. 28) with the hosting provider and the mail provider; check transfers outside the EU.
3. Agree on the use of time recording with the works council where one exists (§87 (1) no. 6 BetrVG) or document the employee information otherwise (§26 BDSG, Art. 13).
4. Set `retention_months` per company with the tax adviser (the default is 36; the legal minimum for working-time records is 24 months, ArbZG §16 (2)).
5. Run and document the restore drill and the data subject request process (see `docs/RUNBOOK.md`).
