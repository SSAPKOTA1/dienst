> Containers: `Dockerfile` (targets `api` and `web`), `docker-compose.prod.yml` and `.env.production.example` run the whole stack; day-to-day operation (deploy, roll back, backups, monitoring, incidents) is in `docs/RUNBOOK.md`. The nginx configuration of the web image is `deploy/nginx.conf` and `deploy/security-headers.conf`.

# Deployment notes: security headers and reverse proxy

The API sets its own security headers (`apps/api/src/lib/securityHeaders.ts`). The web app is a static single-page app, so whatever serves `apps/web/dist` must send the web headers. `vite build` writes them to `dist/_headers` (Netlify/Cloudflare format); the same list lives in `apps/web/security-headers.ts`.

## What is sent

| Header | API | Web app |
|---|---|---|
| Content-Security-Policy | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` | own files only; inline styles allowed (React `style` props, `data:` QR codes); no inline scripts, no frames, no objects |
| Strict-Transport-Security | production only (2 years, includeSubDomains) | send it at the proxy (https only) |
| X-Content-Type-Options, X-Frame-Options, Referrer-Policy | `nosniff`, `DENY`, `no-referrer` | same |
| Permissions-Policy | camera, microphone, geolocation, payment, usb, motion sensors disabled | same |
| Cross-Origin-Opener-Policy / Resource-Policy | `same-origin` / `same-site` | `same-origin` |
| Cache-Control | `no-store` unless a route sets its own | `no-cache` for `index.html` and `sw.js` |
| CORS | only `WEB_ORIGIN`, credentials allowed, methods and headers listed | n/a |

## nginx example (one host, API under `/api`)

```nginx
server {
  listen 443 ssl http2;
  server_name dienst.example.com;
  # ssl_certificate / ssl_certificate_key ...

  root /var/www/dienst;            # apps/web/dist
  index index.html;

  add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Permissions-Policy "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()" always;

  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    # the API believes the address the proxy saw (TRUST_PROXY=1); a client-supplied header only adds entries to the left
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    client_max_body_size 11m;
  }
  location = /sw.js        { add_header Cache-Control "no-cache"; try_files $uri =404; }
  location = /index.html   { add_header Cache-Control "no-cache"; }
  location /assets/        { add_header Cache-Control "public, max-age=31536000, immutable"; }
  location /               { try_files $uri /index.html; }
}
```
Note: `add_header` in a `location` replaces the server-level headers, so repeat the security headers there (or use an `include`).

## Environment
`NODE_ENV=production`, `COOKIE_SECURE=true`, `WEB_ORIGIN=https://dienst.example.com`, and `TRUST_PROXY` set to the number of reverse proxies in front of the API (`1` for the nginx above) or to their addresses (`10.0.0.0/8,192.168.1.5`). `true` is refused in production because it believes any `X-Forwarded-For` and lets a client choose its own address.

## Keys and secrets

| Value | Used for | Notes |
|---|---|---|
| `JWT_SECRET` | master for signing keys | HKDF derives one key each for sessions (`access`), tablet references and confirmations (`kiosk`) and the SSO login flow (`sso`), so a token of one kind is never accepted as another |
| `DATA_KEY` | master for data at rest | HKDF derives one key each for TOTP secrets, documents, import credential sheets, SSO client secrets and the badge hash |
| `TOTP_ENC_KEY` | legacy only | the raw key older databases were written with; still read as a fallback, never used for new data; leave it unset on new installs |

Generate with `openssl rand -hex 32` (`DATA_KEY` needs 64 hex characters, `JWT_SECRET` at least 32 characters). Production refuses the development values and requires `JWT_SECRET` and `DATA_KEY` to differ (and `DATA_KEY` to differ from the legacy key).

**Upgrading an existing database:** set `DATA_KEY`, keep the old `TOTP_ENC_KEY` for now, restart, then run `pnpm security:rekey` once (it re-encrypts everything that an older key still opens and can be re-run safely). Badge hashes move to the new key the first time a badge is used. After that the legacy key can be removed. All sessions are signed out once, because session tokens now use a derived key.

**Rotating:** put the old value into `JWT_SECRET_PREVIOUS` / `DATA_KEY_PREVIOUS` (comma separated for several), set the new value, restart, run `pnpm security:rekey`, and drop the previous value once no old tokens or data remain (access tokens live 15 minutes, refresh tokens are not affected because they are random values stored hashed).

## Outbound requests (SSO)
The server only calls addresses an administrator typed in for SSO. They must be https and publicly routable: private, loopback, link-local (cloud metadata), CGNAT and similar ranges are refused, and so are redirects. For an identity provider inside your own network set `OUTBOUND_ALLOW_PRIVATE=true`; this lets administrators make the server reach internal addresses, so only do it when administrators are trusted and the network is segmented. Also block outbound traffic from the API host to the metadata service at the network level.

## Client address and the web punch
The web punch network check, the per-address rate limits and the audit trail use the client address. With `TRUST_PROXY` unset the app uses the TCP peer, which behind a proxy is the proxy: the check then fails closed (nobody can punch) and the API logs a warning once when it sees an `X-Forwarded-For` header. With `TRUST_PROXY=1` the app takes the address the nearest proxy saw (the last `X-Forwarded-For` entry) and ignores anything a client put in front of it. Web punches store the client address in their audit entry.

## Cookies
With `COOKIE_SECURE=true` (required in production) the session cookie is named `__Secure-rt` and is only accepted by browsers when set over https; it is `HttpOnly`, `SameSite=Strict` and limited to `/api/v1/auth`. Sessions from before this change keep working: the old `rt` cookie is read once, replaced by the new one and cleared. If you serve the API on a different site than the web app, the strict flag blocks the cookie, so keep both under one site (for example `app.example.com` and `api.example.com`) or use the same host with `/api` as shown above.
