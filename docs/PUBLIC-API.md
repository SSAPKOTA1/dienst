# Public API (read only)

Base path `/api/public/v1`. The machine-readable description is at `/api/public/v1/openapi.json`.

## Authentication
An administrator creates a key under Admin → Schnittstellen (or `POST /api/v1/api-keys`). The key looks like `dk_…`, is shown once and is stored only as a hash. Send it as `X-API-Key: dk_…` or `Authorization: Bearer dk_…`. A key belongs to one company and optionally to one hotel. Revoke it at any time. Limit: 120 requests per minute and key.

## Endpoints (GET only)
| Path | Returns |
|---|---|
| `/hotels` | hotels of the key |
| `/employees?hotelId&limit&offset` | personnel number, first and last name, status, primary hotel, department |
| `/schedule?from&to&hotelId` | published shifts (date, start, end, break, shift name) |
| `/attendance?from&to&hotelId` | approved worked time (paid start/end, break minutes, paid hours) |
| `/absences?from&to&hotelId` | approved absences: `vacation` or `absence` (no type, reason or health data) |

`from` and `to` are `YYYY-MM-DD`, at most 366 days apart. `limit` is 1-500 (default 100). Errors use the usual `{ error: { code, message, details } }` format. There are no wages, hourly rates or payroll calculations.
