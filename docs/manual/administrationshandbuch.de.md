# Administrationshandbuch (Deutsch)

Für **Administratorinnen und Administratoren** eines Unternehmens und für die **Super-Administration** (mehrere Unternehmen). Technischer Betrieb (Server, Backups, Notfälle) steht in [../RUNBOOK.md](../RUNBOOK.md) und [../INFRASTRUCTURE.md](../INFRASTRUCTURE.md).

## 1. Rollen

| Rolle | Darf |
|---|---|
| **Super-Administration** | Unternehmen und Hotels anlegen, Hotels deaktivieren und wieder aktivieren, weitere Super-Administratoren anlegen, Administratoren Unternehmen oder einzelnen Hotels zuweisen, Rollen jeder Person ändern, alles darunter |
| **Administration** | Die zugewiesenen Unternehmen (alle ihre Hotels) und/oder einzelnen Hotels: Mitarbeitende (Stammdaten, Hotels, Abteilungen, Vertrag), Benutzer, Tablets, Schnittstellen, Regeln, Monatsabschluss, Protokoll, Datenschutz. Eine Administration für einzelne Hotels sieht und bearbeitet nur die Mitarbeitenden, die in diesen Hotels arbeiten |
| **Leitung** (Manager) | Nur zugewiesene Hotels und Abteilungen: Planung, Anträge, Live, Team; keine Einrichtung, keine Schnittstellen |
| **Mitarbeiter** | Eigene Daten im Portal und am Tablet |

Jede Abfrage wird serverseitig auf die Unternehmen und Hotels der angemeldeten Person eingeschränkt. Eine Person kann mehrere Rollen haben und wählt sie nach der Anmeldung. **Administratoren und Super-Administratoren müssen einen zweiten Faktor einrichten** (Authenticator-App oder Sicherheitsschlüssel/Passkey, siehe _Sicherheit_ im Namensmenü).

## 2. Einrichten (Reihenfolge)

Menü **Admin → Übersicht** zeigt eine Checkliste mit dem Stand der Einrichtung.

1. **Unternehmen** (nur Super-Administration): Name, Aufbewahrungsfrist in Monaten (Standard 36, gesetzliches Minimum für Arbeitszeitnachweise 24), Administrator einladen.
2. **Hotels:** Name, **Zeitzone** (Standard Europe/Berlin), Abteilungen, **Schichtvorlagen** (Beginn, Ende, Pause, Farbe) und **Sollbesetzung** je Vorlage und Wochentag. Die Zeitzone bestimmt Sommerzeit-Berechnungen und den Tag, dem eine Schicht zugerechnet wird (Starttag). Die Super-Administration kann ein Hotel **deaktivieren** (_Admin → Hotels_): Es verschwindet aus Planung, Listen und Tablet, alle Daten bleiben erhalten, und es lässt sich wieder aktivieren. Ein Hotel, in dem noch jemand eingestempelt ist, kann erst deaktiviert werden, wenn alle ausgestempelt haben.
3. **Benutzer & Rollen:** Leitungen und weitere Administratoren einladen und Hotels/Abteilungen zuweisen. Einladungen laufen per E-Mail; ohne E-Mail erzeugst du einen **Aktivierungscode**. Die Super-Administration kann außerdem **weitere Super-Administratoren** einladen, einer Administration **ganze Unternehmen oder einzelne Hotels** zuweisen und bei jeder Person (auch Mitarbeitenden) **Rollen ändern** öffnen: _Super-Admin_, _Administration_ (Unternehmen und/oder Hotels) oder _Leitung_ (Hotels) ankreuzen. Hat eine Person mehrere Rollen, wählt sie bei der Anmeldung. Das Entziehen einer Rolle wirkt sofort und bewahrt die Historie; die eigene Super-Admin-Rolle kannst du nicht entfernen. Eine Rolle für das Personal braucht eine E-Mail-Adresse.
4. **Mitarbeitende anlegen und bearbeiten:** unter _Team → Mitarbeiter_ einzeln oder per **Excel-Import** (Probelauf, Fehler-CSV, einmaliges Zugangsblatt mit Passwörtern/PINs; bewahre es sicher auf und vernichte es). Jede Person bekommt automatisch ein Konto und die Rolle Mitarbeiter. PINs sind 6-stellig, werden einmal angezeigt und nie per E-Mail verschickt. In der Mitarbeiterdetailansicht ändert **Bearbeiten** Stammdaten, Stammhaus, weitere Hotels und Abteilungen; **Vertrag ändern** legt ab einem Datum eine neue Vertragsversion an (Beschäftigung, Arbeitstage, Sollstunden, Urlaubstage); frühere Zeiträume bleiben unverändert. Beides wird protokolliert.
5. **Tablets:** _Admin → Tablets_ → Tablet anlegen; der Einmalcode wird am Gerät unter `/kiosk` eingegeben. Gerätetoken sind widerrufbar. Zeigt das Tablet „Gerät nicht registriert“, wurde der Token widerrufen. Optional **Badge** je Person (QR/NFC) zuweisen.
6. **Regeln:** _Admin → Regeln_ zeigt die gesetzlichen Grenzen (Ruhezeit, Höchstarbeitszeit, Pausen, Jugendliche). Gesetzliche Grenzen lassen sich nicht abschwächen; **Regelprofile** dürfen nur **strenger** sein. Unter **Planungsregeln: weich oder hart** legt die Administration (je Unternehmen oder je Hotel) für jede übrige Einschränkung fest, wie streng sie gilt: **weich** zeigt nur eine Warnung und die Schicht lässt sich trotzdem planen, **weich mit Begründung** verlangt zusätzlich eine schriftliche Begründung, **hart** macht die Planung unmöglich, auch nicht mit der Notfall-Ausnahme. Einstellbar sind: mehr als 8 Stunden pro Tag, Ruhezeit zwischen 10 und 11 Stunden, monatliche Stundengrenze, weniger als 15 freie Sonntage, Nachtarbeitnehmer-Grenze, Abwesenheit, falsche Abteilung, nicht verfügbar, Wünsche und fehlende Qualifikation. Gesetzliche und technische Grenzen (mehr als 10 Stunden pro Tag, Ruhezeit unter 10 Stunden, Jugendliche, Überschneidung, vergangene Tage, abgeschlossene Monate, anderes Hotel, kein gültiger Vertrag) werden angezeigt, bleiben aber immer hart. Hat ein Hotel eigene Einstellungen, ersetzen sie die des Unternehmens als Ganzes; das Speichern der Arbeitszeitgrenzen behält die Einstellungen weich/hart. Funktionen (Wünsche, Tauschen, offene Schichten, Verfügbarkeit, Mitteilungen, Beiträge, Nachrichten, Dokumente, Kalender-Abo, Team-Kalender) schaltest du pro Unternehmen ein oder aus; Web-Stempeln erlaubst du je Hotel über die erlaubten Netzbereiche. Stundenkategorien (Nacht, Sonntag, Feiertag, Heiligabend/Silvester) sind anpassbar; das System berechnet nur **Minuten, keine Löhne**.
7. **Schnittstellen:** API-Schlüssel (nur lesend, mit Ablauf, Rechten und optionalem Netz) und **Single Sign-on (OpenID Connect)**. Siehe [../PUBLIC-API.md](../PUBLIC-API.md). Schlüssel werden einmal angezeigt; tausche sie vor dem Ablauf (Hinweis 14 und 3 Tage vorher).

## 3. Täglicher und monatlicher Betrieb

- **Anträge, Live, Compliance:** siehe Benutzerhandbuch, Abschnitte 4–6. Plane, dass Leitungen täglich offene Anträge abarbeiten.
- **Monatsabschluss:** _Admin → Übersicht → Monatsabschluss_. Der Abschluss schlägt fehl, solange Freigaben oder Korrekturen offen sind (die Liste wird angezeigt). Danach sind Planung, Stempelungen, Korrekturen und Abwesenheiten im Zeitraum gesperrt. **Wieder öffnen** nur mit Begründung; beides wird protokolliert. Danach Stunden exportieren: Stundenzettel (PDF/Excel), Lohnexport (nur Stunden), Anwesenheits-CSV.
- **Hintergrundaufgaben:** automatisches Ausstempeln, Urlaubsübertrag, Erinnerungen, Austritte, Aufbewahrung. Sie laufen in einem eigenen Worker-Prozess (`RUN_JOBS`); Alarme melden, wenn sie stehen.

## 4. Protokoll und Nachvollziehbarkeit

_Admin → Protokoll_ listet jede Änderung (wer, Rolle, was, alt/neu, Grund). Der Protokollbestand ist verkettet und nur anfügbar; **Prüfen** weist Manipulationen nach. Filter nach Person, Aktion, Zeitraum. Lesezugriffe auf Personenakten, Datenexporte und Dokument-Downloads werden ebenfalls protokolliert.

## 5. Datenschutz im Betrieb

Vorlagen und Prozesse: [../privacy/README.md](../privacy/README.md).

- **Auskunft/Export:** Datenexport je Person (Mitarbeiterakte → Datenexport). Beantworte Anfragen binnen eines Monats.
- **Löschung/Anonymisierung:** Arbeitszeitnachweise müssen mindestens 24 Monate bleiben; nach Ablauf der Aufbewahrungsfrist anonymisiert ein täglicher Job. Vorzeitig löschen geht nur für nicht aufbewahrungspflichtige Daten; der Ablauf steht in `DATA-SUBJECT-REQUESTS.md`.
- **Betreiberpflichten:** Verarbeitungsverzeichnis und Datenschutz-Folgenabschätzung ausfüllen, Auftragsverarbeitung mit Hoster und Mailanbieter, Betriebsrat/Mitarbeiterinformation, Fristen mit der Steuerberatung festlegen.

## 6. Sicherheit im Alltag

- Verlorene Geräte: Tablet-Token widerrufen; Sicherheitsschlüssel entfernen.
- Ausgeschiedene Personen: _Deaktivieren_ beendet alle Sitzungen; der Austritts-Job anonymisiert nach Fristablauf.
- Passwörter min. 10 Zeichen, fünf Fehlversuche sperren; PIN-Sperre 15 Minuten, aufhebbar durch die Leitung.
- Vermutetes Datenleck: siehe Vorfall-Checkliste in [../RUNBOOK.md](../RUNBOOK.md) (Schlüssel rotieren, API-Schlüssel widerrufen) und melde Datenschutzverletzungen binnen **72 Stunden** der Aufsichtsbehörde (Art. 33 DSGVO).

## 7. Fehlerbilder

| Beobachtung | Ursache / Maßnahme |
|---|---|
| Tablet: „Gerät nicht registriert“ | Token widerrufen oder falsch; neu anlegen unter _Tablets_ |
| Web-Stempeln lehnt ab | Nur aus dem Hotelnetz erlaubt; Netzbereiche und `TRUST_PROXY` prüfen |
| Monatsabschluss lehnt ab (`PENDING_APPROVALS`) | Offene Freigaben abarbeiten |
| Änderung gesperrt (`PERIOD_CLOSED`) | Monat wieder öffnen (mit Begründung) |
| Plan lässt sich nicht speichern (`RULE_BLOCKED`) | Regel verletzt; ändern oder Notfall-Override mit Begründung |
| E-Mails kommen nicht an | SMTP-Einstellungen; `MAIL_MODE` darf in Produktion nicht `json` sein |
