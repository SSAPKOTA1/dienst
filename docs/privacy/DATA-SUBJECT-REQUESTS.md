# Answering data subject requests

Deadline: one month (Art. 12 (3) GDPR), extendable by two months for complex cases. Check the identity of the requester before sending data.

## Access (Art. 15) and portability (Art. 20)
- The employee can download everything themselves: portal, Konto, "Meine Daten herunterladen" (`GET /me/data-export`, JSON).
- An administrator can do the same for a person: `GET /employees/:id/data-export`. The export is logged (`personal_data_exported`).
- The export contains the profile, account data, contracts, schedule, punch records, absences, corrections, notifications, wishes, availability, qualifications, vacation allowances, time account entries and the list of documents (files are downloaded separately from the person's record). It does not contain secrets (PIN, password, tokens).
- Who looked at the data: `GET /employees/:id/access-log` (admins, with names) and `GET /me/access-log` (the person, role and time only).

## Rectification (Art. 16)
Administrators edit the profile and contracts in the staff screen; changes are audited.

## Erasure (Art. 17)
- While the person is employed or the retention period runs, working-time data must be kept (Art. 17 (3) (b)). Answer the request with the reason and the date from which erasure is possible (`eligibleFrom`).
- Optional extras (documents, wishes, availability) can be removed by an administrator on request; [document how you handle partial requests].
- After the period: `POST /employees/:id/anonymise` with a reason, or wait for the daily job.

## Restriction and objection (Art. 18, 21)
Handle case by case with the data protection officer; deactivating the person stops planning and login while keeping the records.

## Log of requests
Keep a list outside the app: date received, requester, type, decision, date answered, [responsible person].
