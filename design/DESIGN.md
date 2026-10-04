# DESIGN.md - how to use the front-end design

The design is a clickable prototype made in Claude Design (Trip Inn "Dienstplan & Zeiterfassung"). It defines the look, the screens and the interaction details. `SPEC.md` defines behaviour, data and rules. **Where the two disagree, section 4 below decides.**

## 1. Files
| File | Use |
|---|---|
| `prototype.html` | Open in a browser. All views reachable from the top navigation. German by default, English via the language switch. Use it as the visual reference while building. |
| `prototype-source/template.html` | Readable source of the prototype (markup, styles, mock logic, labels). Grep it for exact layouts, colours, copy and behaviour (for example `warnFor`, `diffOf`, `kPunch`). Do NOT port its runtime or its custom `sc-if` / `sc-for` template tags; re-implement in React + Tailwind. |
| `tokens.css` | Design tokens and component classes (colours, spacing, buttons, tags, table, dialog, nav). Import it as the base stylesheet and expose the tokens in the Tailwind config. |
| `fonts/` | Archivo (variable, latin / latin-ext / vietnamese). Alternatively install `@fontsource-variable/archivo`. |
| `i18n-de-en.json` | 402 German UI strings with English translations. Seed `apps/web/src/i18n/de.json` and `en.json` from it; German is the default language. Add keys for new screens in both languages. |
| `sample-data.json` | The prototype's sample hotels, departments, shifts and 15 employees (no wage field). Use it for `pnpm db:seed` so the real UI looks like the prototype. |

## 2. Visual language (from `tokens.css`)
- Modernist: flat, **radius 0 everywhere**, hairline dividers, no decoration. Background `#f3f2f2`, surface `#eae9e9`, text `#201e1d`, accent `#ec3013` (red-orange), second accent `#e15b47`.
- Tonal ramps `--color-neutral-100..900`, `--color-accent-100..900`, `--color-accent-2-100..900`.
- Font Archivo; headings weight 800, tight tracking (-0.015em); body 15 px / 1.55; h6 is uppercase with letter spacing.
- Spacing 4, 8, 12, 16, 24, 32 px. Shadows `sm/md/lg` are soft ink-tinted.
- Component classes to keep: `btn`, `btn-primary`, `btn-secondary`, `btn-ghost`, `btn-icon`, `card`, `tag` (`tag-accent`, `tag-neutral`, `tag-outline`), `table`, `dialog`, `field`, `input`, `seg` / `seg-opt` (segmented control), `nav`.
- Light theme only in the prototype. A dark theme is not required for v1.
- Never colour alone: absence chips carry text codes (Urlaub, Berufsschule, Krank, Frei); warnings carry an icon and a title.

## 3. Information architecture
Top navigation sections with a sub-navigation per section:
| Section | Sub-views | Prototype view id | v1 |
|---|---|---|---|
| Planung | Dienstplan (roster) | `roster` | yes |
| Planung | Urlaub (vacation planner) | `vac` | **v2, hidden** |
| Heute | Live | `live` | yes |
| Heute | Anträge (requests inbox) | `requests` | yes (reduced, see 4) |
| Team | Mitarbeiter (staff) | `staff` | yes |
| Admin | Einrichtung (setup) with tabs Übersicht, Hotels, Benutzer & Rollen, Tablets, Regeln, Protokoll | `admin` | yes (Regeln read-only) |
| Ansichten | Tablet (kiosk), Handy-Portal (employee), Anmelden (login) | `kiosk`, `portal`, `login` | yes; these are real routes (`/kiosk`, `/me`, `/login`), not a demo switcher |
The "Ansichten" switcher, the Desktop/Handy width toggle and the "Erste Schritte" panel are prototype helpers: do not build the switcher; build the checklist as a dashboard widget on the admin overview (`GET /setup/status`).

## 4. Screen inventory and decisions where design and SPEC differ
Legend: **build** = in v1; **v2** = designed, do not build now, hide it; **change** = build differently from the prototype.

### 4.1 Dienstplan (roster)
| Prototype feature | Decision |
|---|---|
| Week grid, employee view and "Nach Dienst" shift view, KW label, previous/next week, "Aktuelle Woche / Kommende Woche / Vergangen · gesperrt" chips | **build** |
| Hotels and Abteilungen as multi-select dropdowns with counts and search; grid shows several hotels at once, employees of another hotel marked "Anderes Hotel / In Berlin / Stammhaus: Berlin" | **build** (API takes `hotelIds[]`, `departmentIds[]`) |
| Draft vs published per cell (Entwurf / Veröffentlicht), "Änderungen seit der letzten Veröffentlichung" panel with Neu / Geändert / Entfernt, "Alle verwerfen", "Änderung verwerfen", publish button "N Entwürfe veröffentlichen", note that employees with published shifts are notified | **build** (SPEC 4.18) |
| Click a cell/entry for the side panel (assign, save, remove, reason field), drag a shift from the palette ("Schicht ziehen"), drag onto cells, drag to the delete zone ("Zum Löschen hierher ziehen"), cut icon, cell menu to assign shifts or absences | **build** (this is the + menu and drag behaviour of SPEC 6.2) |
| "Vertretung finden" candidate list ("Verfügbare Mitarbeiter", order: no warning, few weekly hours) | **build** (SPEC 4.17); the "Wunsch" criterion is v2 |
| "Vorwoche kopieren", "Plan leeren" with counts and confirmation | **build** |
| Coverage row "Besetzung · min." with "Unterbesetzt" | **build**, per department and day: assigned vs the sum of that department's shift requirements (SPEC 4.9). Seed requirements so the numbers equal the prototype's minimums |
| Warnings: Ruhezeit, Jugendarbeitsschutz, Unterbesetzt, "Widerspricht Wunsch" | **build** the first three from the server rule results; "Widerspricht Wunsch" is v2 |
| Wish markers (prefer/avoid) in cells | **v2** |
| PDF via browser print (`Drucken / PDF`, print stylesheet) | **change**: keep browser print for the schedule, plus a server XLSX export. Timesheet PDFs stay server-side |
| Reason field "Begründung (bei Minderjährigen Pflicht, wird protokolliert)" and "Gespeichert · Begründung protokolliert" | **build** as the `needs_reason` flow; the reason is audit-logged |
| Minors: prototype saves a 12 h rest violation with a reason | **change**: SPEC rule `MINOR_REST` blocks it; only an admin/super admin can use `emergencyOverride` with a reason. Render it red, not amber |
| Rest period under 11 h shown as a warning | **change**: SPEC `REST_PERIOD`: amber with reason between 10 and 11 h, red (blocked) under 10 h |
| Week range only (no month view) | **gap**: the Week/Month toggle from the SPEC is not in the prototype. v1 ships the week range; the API supports `range=month`; a compact month overview is a later UI task |

### 4.2 Live
Prototype: "Live-Übersicht", server time, groups Eingestempelt / Erwartet, nicht da / Prüfung nötig / Nicht erschienen, button "Per Korrektur schließen". **Build** (SPEC 4.16).

### 4.3 Anträge (requests inbox)
| Group in prototype | Decision |
|---|---|
| Abwesenheiten: Urlaub requests with "Rest 18,5 → 14,5" and an under-staffing hint | **build** for vacation requests (SPEC 4.19), Approve / Reject |
| Abwesenheiten: "Krankmeldung" items | **remove**: sickness is not reported in the app; planners mark it on the plan (project decision). If you later want employee sick reports, they come back as a request type |
| Stempelkorrekturen (missing clock-out, wrong clock-in time with reason) | **build** (SPEC 4.7) |
| Wünsche (Freiwunsch, Urlaubswunsch) | **v2** |
| (not in prototype) flagged worked-time records | **add a group "Zeiten prüfen"**: variations outside grace, unplanned, under-break, auto-checkout (SPEC 4.6) |

### 4.4 Mitarbeiter (staff)
List with Name, Nr., Abteilung, Soll/Woche, Urlaub übrig, Zeitkonto, search, "Mitarbeiter anlegen"; detail with Personalnummer, Stammhaus, Geburtsdatum, Beschäftigung, Arbeitstage, Soll pro Woche, Resturlaub, Tablet-PIN block (PIN zurücksetzen, Sperre aufheben, "Wird nur einmal angezeigt. Persönlich übergeben.").
- **build** all of it, with: `personnel_number` (auto-generated, SPEC 3), Zeitkonto as a computed read-only value (SPEC 4.15), PIN shown once.
- **remove** the field "Stundenlohn" and any wage data: the app has no payroll.
- **change**: the "Reduzierte Ansicht" rule is kept: only managers of the employee's home hotel (Stammhaus) see working days, vacation, time account and absence types; managers of other hotels see name, hotel, department and an "Abwesend" marker only. Contact data and date of birth stay admin/super admin only.

### 4.5 Admin (Einrichtung)
| Tab | Decision |
|---|---|
| Übersicht: KPIs (Mitarbeitende, Aktive Benutzer, Tablets online, Offene Anträge), Handlungsbedarf, Letzte Änderungen, Erste Schritte checklist | **build** (`GET /setup/status`, audit feed) |
| Hotels und Mindestbesetzung: hotels, departments, minimum staffing, shifts | **build** (departments, shift templates, staffing requirements) |
| Benutzer & Rollen: invite user, role, hotel access, last login, active | **build** (`GET /users`, `last_login_at`) |
| Tablets: online/offline/locked, lock/unlock, "Tablet koppeln" | **build** (kiosk heartbeat, status active/revoked) |
| Regeln: Mindest-Ruhezeit, Tablet-Stempeln, Funktionen, Sperrzeiten für Urlaub | **build read-only** (shows the built-in rules); editable rules, feature toggles and blackout periods are **v2** |
| Protokoll: change log with filters and "Als CSV exportieren" | **build** (`GET /audit-log`, CSV export) |

### 4.6 Tablet (kiosk)
Prototype: "Tippe auf deinen Namen", "Nicht dabei? Namen suchen", PIN pad, "Falsche PIN. Noch 4 Versuche.", result "Eingestempelt 06:14" with "Deine Leitung sieht das", server time note.
- **build** as in SPEC 6.3 and 5.6.
- **change**: the prototype says the planned break is deducted automatically with no confirmation. Keep the SPEC flow: at clock-out show one screen with the required/planned break pre-selected and a single "OK" tap, plus options 0/15/30/45/60; a shorter break needs a reason.
- **change**: PIN length is **6** (company default `pin_length = 6`, SPEC 4.12); 5 wrong attempts lock for 15 minutes; the message shows remaining attempts. Remove the demo text ("jede PIN außer 000000").

### 4.7 Handy-Portal (employee)
Home with next shifts, "Diese Woche", Arbeitszeitkonto, Urlaub, notifications; actions: Urlaub beantragen, Krank melden, Schicht- oder Freiwunsch, Stempelzeit korrigieren, Frage an die Leitung.
| Action | Decision |
|---|---|
| Urlaub beantragen (from/to, preview of days, remaining check, blackout hint) | **build** without half days and without the blackout hint (v2) |
| Stempelzeit korrigieren | **build** ("Die Originalzeiten bleiben gespeichert") |
| Krank melden | **remove** (see 4.3) |
| Schicht- oder Freiwunsch | **v2** |
| Frage an die Leitung (messages) | **v2** |
| Arbeitszeitkonto, Urlaub übrig, Diese Woche, Nächste Schichten, Benachrichtigungen | **build** |

### 4.8 Anmelden (login)
Field "E-Mail oder Benutzername", password (min. 10 characters), "Passwort vergessen?" with the two explanations (mail link, or ask the manager), "Neu hier?" text about the invitation link. **build**; add the TOTP step for admins and the role selector after login (SPEC 5.2).

### 4.9 Urlaub (vacation planner)
Table per employee (Anspruch, Übertrag, Genommen, Geplant, Beantragt, Rest), year overview, blackout periods, employee wishes, manual entry with half days, status. **v2: do not build in v1.** Keep the route and nav entry out of the v1 navigation.

## 5. Sample data
`sample-data.json` holds: hotels Frankfurt (Stammhaus Berlin for some staff) and Berlin; departments Rezeption (fd), Housekeeping (hk), Frühstück (bf); shifts Früh 06-14, Spät 14-22, Nacht 22-06 (Rezeption), Tag 08-16:30 (Housekeeping), Frühstück 06-11; absences Urlaub (U), Berufsschule (S), Krank (K), Frei (F); 15 employees with weekly target, contract kind (Vollzeit, Teilzeit, Minijob, Azubi), weekly pattern, personnel number, birth date, vacation, time account, carryover, flags `minor` and `floating`. Today in the prototype is 2026-10-01; seed relative to the seed run date, keeping week structure. Planned hours per shift in the sample are net of a 30-minute break (8 h shift = 7.5 h).
