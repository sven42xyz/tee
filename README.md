# tee

**Live:** https://tee.chapter42.de

Move text, links and files between devices quickly (e.g. phone → laptop), no login.

The name comes from the Unix command `tee`: one input, many outputs. Whatever one device sends into a room arrives on all the others.

1. Click **"Create room"** on the start page. You get a 6-character code (no look-alike characters and no vowels, so it cannot spell words) and a QR code.
2. On the second device, scan the QR code, open the link, or type the code on the start page.
3. Text, links and files (file picker, drag & drop or paste from the clipboard) appear instantly on every connected device.

Rooms are deleted automatically **24 h after the last activity** (at the latest 7 days after creation), including all files.

## Architecture

```
Browser ──HTTP──▶ Worker (src/worker.ts)
   ▲               ├─ /api/*  → src/server/api.ts ──RPC──▶ Durable Object "Room" (one per room, SQLite)
   │               │                    │                      ├─ items/meta in SQLite
   │               │                    └─ upload/download ──▶ R2 (rooms/<CODE>/<id>)
   │               └─ everything else → Astro (SSR + static assets)
   └────WebSocket (Hibernation API) ◀──────────────────────────┘
```

- **One Worker** with a custom entrypoint, `src/worker.ts`. It exports the `Room` Durable Object and hands every non-API request to Astro (`@astrojs/cloudflare/handler`).
- **One Durable Object per room** (`src/server/room.ts`), SQLite-backed:
  - Tables `meta` (code, encrypted, created_at, last_activity) and `items` (text/link/file, file metadata, status `pending` / `ready`).
  - WebSockets via the **Hibernation API** (`ctx.acceptWebSocket`). `ping`/`pong` is handled by `setWebSocketAutoResponse`, so the DO does not have to wake up for it.
  - **Alarm**: every activity pushes it to now + 24 h, capped at 7 days after creation. When it fires, it deletes all R2 objects under `rooms/<CODE>/` and then the entire DO storage.
- **Uploads** stream through the Worker into R2: the DO first reserves an item (checking the 50-item limit), the body is written to R2 through a `FixedLengthStream`, then the DO commits the item and broadcasts it to every device.
- **Rate limiting** via the Workers rate limiting binding, keyed by IP (`cf-connecting-ip`).
- **Cost ceiling** via a single `Quota` Durable Object (`src/server/quota.ts`, `idFromName('global')`):
  - Total file storage in R2 is capped (50 GB). Rooms report uploads and deletions; an alarm recounts the real total from R2 every 6 hours, so the counter cannot drift.
  - Upload volume (files + texts) per IP and UTC day is capped (2 GB). IPv6 addresses are grouped by /64. Deleting does not refund the daily volume. Only a SHA-256 hash of day + IP bucket is stored, rows are dropped after two days.
  - Rooms reserve quota before accepting an upload and release it when files are deleted, uploads fail or rooms expire.
- **Turnstile** protects room creation. The Worker verifies the token via `siteverify`. Without configured keys, Turnstile is disabled.
- **Languages: German and English.** The middleware (`src/middleware.ts`) picks the language from the `lang` cookie, then `Accept-Language`, then falls back to English. `?lang=de` / `?lang=en` sets the cookie and redirects to the URL without the parameter. Room URLs stay language-neutral (`/<CODE>`). All UI strings live in `src/i18n/index.ts`.

### End-to-end encryption

Rooms are end-to-end encrypted by default (`src/scripts/crypto.ts`, Web Crypto, AES-256-GCM):

- On creation, the browser generates a random 256-bit key and appends it to the link as a fragment: `/ABC234#k=…`. Browsers never send the fragment to the server; the QR code and "copy link" include it.
- **Texts/links**: `{ k: 'text'|'link', c }` encrypted as JSON, Base64url(IV | ciphertext).
- **Files**: in 1 MiB chunks. Header `TEE1 | nonce prefix[8] | chunk size`, IV per chunk = prefix | chunk index, and the AAD marks the last chunk (detects reordering and truncation). Name, type and original size travel encrypted in the `X-Filename` header (`X-Encrypted: 1`).
- The server only stores ciphertext. It sees the number, size and time of items, and whether an item is text or a file. It enforces the room's mode (`409 wrong_mode`).
- Anyone opening the code without the key sees a lock screen and can paste the link there.
- Unticking "End-to-end encrypted" on creation gives a room like before: joinable with the code alone, content stored in plain text.

> Web Crypto is only available in secure contexts (HTTPS, `localhost`). When testing over `http://<LAN-IP>`, encrypted rooms therefore do not work; unencrypted ones do.

### Security headers

`src/server/security.ts` adds security headers to every Worker response (except WebSocket upgrades):

- **Content-Security-Policy**: scripts, styles and connections only from tee itself, plus Cloudflare Turnstile (`challenges.cloudflare.com`); no inline scripts or styles, `frame-ancestors 'none'`, `object-src 'none'`. Astro is configured to always ship JS and CSS as files (`inlineStylesheets: 'never'`, `assetsInlineLimit: 0`). Skipped in `astro dev`, where Vite injects styles at runtime.
- **Strict-Transport-Security**, **X-Content-Type-Options: nosniff**, **Referrer-Policy: no-referrer** (room URLs carry the room code), **Permissions-Policy**, **Cross-Origin-Opener-Policy**, **X-Frame-Options**.

When adding third-party resources, extend the CSP in `security.ts`, otherwise the browser blocks them.

### Moderation (reports, blocking, deletion)

Runbook: [docs/abuse.md](docs/abuse.md).

- Every room has **"Report content"** (also on the lock screen of encrypted rooms). Reports are stored in the `Moderation` Durable Object (180 days) and emailed to the operator via the `send_email` binding (Email Routing).
- **Reports of CSAM or of sexual violence / intimate images without consent block the room immediately**, before anyone has reviewed them.
- The email contains a **signed moderation link** (HMAC with `ADMIN_SECRET`, valid 14 days) to `/admin/<CODE>`: metadata and reports, never content, plus the actions block, freeze (keep up to 90 days for the authorities), unblock and delete.
- Blocked rooms return `451` everywhere and disconnect all devices.
- Terms of use: `/nutzungsbedingungen`.

### API

| Method & path | Purpose |
|---|---|
| `POST /api/rooms` | Body `{ turnstileToken, encrypted }` → `{ code }` (Turnstile + rate limit `RL_CREATE`) |
| `GET /api/rooms/:code` | Does the room exist? 200 / 404 |
| `GET /api/rooms/:code/ws` | WebSocket for live sync |
| `POST /api/rooms/:code/text` | `{ text }` (links are detected) or `{ ciphertext }` in encrypted rooms |
| `POST /api/rooms/:code/files` | Raw body. Plain: headers `X-Filename` (URL-encoded) and `Content-Type`. Encrypted: `X-Encrypted: 1`, `X-Filename` = encrypted metadata |
| `GET /api/rooms/:code/files/:id` | Download (`Content-Disposition: attachment`) |
| `DELETE /api/rooms/:code/items/:id` | Delete an item |
| `POST /api/rooms/:code/report` | `{ category, description, contact?, itemId?, goodFaith: true }` → `{ id, blocked }` |
| `POST /api/admin/rooms/:code` | `{ action: block\|freeze\|unblock\|delete, exp, sig }` (signed link from the report email) |

WebSocket messages (server → client): `init`, `item`, `delete`, `devices`. See `src/shared/types.ts`.

Error responses are `{ error, message }`. The client translates the `error` code; `message` is English and meant for debugging.

### Limits

| | |
|---|---|
| Max. file size | 100 MB (`src/shared/limits.ts`) |
| Max. items per room | 50 |
| Max. text length | 100 KB |
| Room creation | 10 / minute / IP |
| Uploads, text, deletes | 30 / minute / IP |
| Upload volume | 2 GB / day / IP (IPv6: per /64) |
| Total file storage | 50 GB (uploads are rejected beyond that) |
| Lifetime | 24 h after the last activity, at most 7 days |

> The rate limiting binding counts per Cloudflare location and is not exact. That is good enough for abuse protection here.
> Cloudflare limits the request body size by plan (Free/Pro: 100 MB). Higher limits would need multipart uploads.

## Project structure

```
src/
├─ worker.ts              Worker entrypoint (API + Astro + export Room)
├─ middleware.ts          Language detection (cookie / Accept-Language / ?lang=)
├─ server/
│  ├─ api.ts              API routes, validation, rate limiting, Turnstile, R2 streaming
│  ├─ room.ts             Durable Object per room (SQLite, WebSockets, alarm, block/freeze)
│  ├─ quota.ts            Durable Object enforcing storage and upload limits
│  ├─ moderation.ts       Durable Object for reports, signed admin links, report emails
│  └─ security.ts         Security headers (CSP, HSTS, …) for every response
├─ shared/                Code shared by client and server
│  ├─ codes.ts            Room code generation / validation
│  ├─ limits.ts           Limits & TTL
│  ├─ types.ts            Item and message types
│  ├─ legal.ts            Provider details for Impressum / privacy policy
│  └─ site.ts             Repo and support links
├─ i18n/index.ts          UI strings DE/EN, error codes → messages
├─ pages/
│  ├─ index.astro         Landing page
│  ├─ [code].astro        Room view (404 for unknown codes, noindex)
│  ├─ admin/[code].astro  Moderation page (signed link only)
│  ├─ nutzungsbedingungen.astro  Terms of use
│  ├─ impressum.astro     Legal notice
│  └─ datenschutz.astro   Privacy policy
├─ scripts/
│  ├─ room-client.ts      WebSocket, reconnect, uploads with progress, drag & drop, decryption
│  ├─ crypto.ts           End-to-end encryption (keys, texts, chunked files)
│  ├─ report-client.ts    "Report content" dialog
│  ├─ turnstile.ts        Turnstile widget (explicit rendering)
│  └─ ui.ts               Toast, clipboard
├─ components/            SiteHeader, SiteFooter, Logo, LangSwitch, TransferScene (animation)
├─ layouts/               Base, LegalPage
└─ styles/global.css      Color tokens, light/dark mode, base styles
og/                       Template and render script for the social preview images
docs/abuse.md             Runbook for reports and illegal content
```

## Setup

Requirements: Node.js ≥ 22, a Cloudflare account for deployment.

```sh
npm install
cp .dev.vars.example .dev.vars   # Turnstile test keys for local development
```

## Development

```sh
npm run dev       # astro dev, runs in workerd incl. Durable Objects, R2 & rate limits (simulated locally)
```

→ http://localhost:4321

To test the production build locally with **wrangler dev**:

```sh
npm run preview   # astro build && wrangler dev
```

→ http://localhost:8787

Local data (DO storage, R2) lives in `.wrangler/state/` and can simply be deleted.
To test on a phone on the same Wi-Fi: `npm run dev -- --host`, then open `http://<LAN-IP>:4321` (unencrypted rooms only, see above).

More scripts:

```sh
npm run check       # type check (astro check)
npm run cf-typegen  # regenerate env types from wrangler.jsonc (worker-configuration.d.ts)
```

Social preview images for shared links (`public/og-de.png`, `public/og-en.png`) are rendered from the template `og/og.html`:

```sh
npm run og   # renders both languages with headless Chrome (macOS path, otherwise set CHROME=…)
```

> **Tip:** to test the alarm locally, temporarily set `ROOM_TTL_MS` in `src/shared/limits.ts` to e.g. `5000`.

## Deployment

1. Log in to Cloudflare:
   ```sh
   npx wrangler login
   ```
2. Create the R2 buckets (once):
   ```sh
   npx wrangler r2 bucket create tee-files --jurisdiction eu
   npx wrangler r2 bucket create tee-files-preview --jurisdiction eu   # for previews
   ```
3. Build and deploy:
   ```sh
   npm run deploy    # astro build && wrangler deploy
   ```
   On the first deploy, migration `v1` creates the SQLite class `Room`.
4. **Custom domain**: configured under `routes` in `wrangler.jsonc` (currently `tee.chapter42.de`). The zone has to be in the same Cloudflare account; the deploy then creates the DNS record itself:
   ```jsonc
   "routes": [{ "pattern": "tee.chapter42.de", "custom_domain": true }]
   ```

### Turnstile

For tee this is already done: the widget "tee Raumerstellung" exists, the site key is in `wrangler.jsonc`, and the secret key is stored as a secret for production and the `main` preview. For a fresh setup:

```sh
npx wrangler login   # needs the challenge-widgets.write scope
npx wrangler turnstile widget create "tee Raumerstellung" \
  --domain tee.chapter42.de --domain tee.<account>.workers.dev \
  --domain main-tee.<account>.workers.dev --mode managed
```

1. Put the **site key** from the output into `wrangler.jsonc` under `vars.TURNSTILE_SITE_KEY` and `previews.vars.TURNSTILE_SITE_KEY`.
2. Store the **secret key** as a secret:
   ```sh
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler preview secret put TURNSTILE_SECRET_KEY --name main
   ```
3. `npm run deploy`

For another custom domain, add it to the widget with `wrangler turnstile widget update <sitekey> --domain …`.
While either key is missing, Turnstile stays off. Rate limiting still applies.

### Moderation secrets

```sh
openssl rand -base64 32 | npx wrangler secret put ADMIN_SECRET   # HMAC key for moderation links
npx wrangler secret put REPORT_TO                                # verified Email Routing destination
```

Set both for the preview as well (`npx wrangler preview secret put … --name main`).

### Previews

The `previews` block in `wrangler.jsonc` gives previews their own R2 bucket (`tee-files-preview`) and their own rate limit namespaces. Prerequisite: the Worker has been deployed normally at least once.

```sh
npm run deploy:preview -- --name my-feature   # without --name: the current git branch
```

URL: `https://<name>-tee.<account>.workers.dev`, plus a unique URL per deployment.
Delete with `npx wrangler preview delete --name <name>`. `wrangler preview` is currently in open beta.

Live logs:

```sh
npx wrangler tail
```

### Configuration

- **Limits / TTL / quotas**: `src/shared/limits.ts`
- **Rate limits**: `ratelimits` in `wrangler.jsonc` (`period` must be 10 or 60 seconds)
- **Bucket name**: `r2_buckets` in `wrangler.jsonc`
- **Legal details**: `src/shared/legal.ts`

After changing `wrangler.jsonc`, regenerate the types with `npm run cf-typegen`. The `dev` and `build` scripts do that automatically.

## Out of scope

Accounts, persistence beyond 24 h, multipart uploads > 100 MB, password-protected rooms.
In unencrypted rooms, anyone who knows the code has access. With 28⁶ ≈ 481 million possible codes and the rate limit, guessing is impractical, but the code is not a secret. Encrypted rooms are additionally protected by the 256-bit key in the link.
