# Public API (read only)

Base path `/api/public/v1`. The machine-readable description is at `/api/public/v1/openapi.json`.

## Authentication
An administrator creates a key under Admin → Schnittstellen (or `POST /api/v1/api-keys`). The key looks like `dk_…`, is shown once and is stored only as a hash. Send it as `X-API-Key: dk_…` or `Authorization: Bearer dk_…`. A key belongs to one company and optionally to one hotel, and it is limited in three ways when it is created:

- **Expiry:** 30 days to 2 years (default 1 year). An expired key answers `401`. The creator and the company administrators get a notification 14 and 3 days before. Create a new key and revoke the old one to rotate.
- **Scopes:** `hotels:read`, `employees:read`, `schedule:read`, `attendance:read`, `absences:read`. A request for something outside the scopes answers `403` with `requiredScope`. Give a key only what its user needs (a payroll tool does not need `schedule:read`).
- **Network (optional):** IP addresses or CIDR ranges the key may be used from; other addresses answer `403`. Behind a proxy this needs `TRUST_PROXY` (see `docs/DEPLOYMENT.md`).

Revoke a key at any time. Limit: 120 requests per minute and key.

## Endpoints (GET only)
| Path | Returns |
|---|---|
| `/hotels` | hotels of the key |
| `/employees?hotelId&limit&offset` | personnel number, first and last name, status, primary hotel, department |
| `/schedule?from&to&hotelId` | published shifts (date, start, end, break, shift name) |
| `/attendance?from&to&hotelId` | approved worked time (paid start/end, break minutes, paid hours) |
| `/absences?from&to&hotelId` | approved absences: `vacation` or `absence` (no type, reason or health data) |

`from` and `to` are `YYYY-MM-DD`, at most 366 days apart. `limit` is 1-500 (default 100). Errors use the usual `{ error: { code, message, details } }` format. There are no wages, hourly rates or payroll calculations.
