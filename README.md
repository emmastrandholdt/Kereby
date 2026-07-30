# Kereby Render Monitor

Dette repository kører som en Render Background Worker og overvåger `https://kerebyudlejning.dk` hvert 15. sekund.

Løsningen er langkørende og bruger en Render worker, ikke en cron job.

## Hvad der sker

- `scripts/monitor.mjs` kører kontinuerligt i et `while (true)` loop.
- Der foretages kun et nyt tjek, når det forrige er færdigt.
- Der waits `POLL_INTERVAL_MS` efter hvert afsluttet tjek.
- Worker-processen logger fejl, men fortsætter efter fejl.
- Der tjekkes kun mellem `08:00` og `16:00` i tiden `Europe/Copenhagen`.
- `state/seen.json` gemmes før eventuel email-send for at undgå gentagne mails.

## Render konfiguration

Render-opsætningen findes i `render.yaml`.

Build Command: `npm ci`
Start Command: `npm start`

### Render service

- type: `worker`
- name: `kereby-monitor`
- runtime: `node`
- plan: `starter`
- persistent disk: `state` monteret på `/opt/render/project/src/state`

### Fast environment variables

- `BASE_URL=https://kerebyudlejning.dk`
- `RENTALS_API_BASE_URL=https://api.jorato.com`
- `STATE_PATH=/opt/render/project/src/state/seen.json`
- `EMAIL_TO=emma.strandholt7000@gmail.com`
- `MAX_RENT=9500`
- `MIN_ROOMS=0`
- `POLL_INTERVAL_MS=15000`
- `MONITOR_TIMEZONE=Europe/Copenhagen`
- `MONITOR_START_HOUR=8`
- `MONITOR_END_HOUR=16`

### Secrets (Render env vars, sync: false)

- `RENTALS_API_KEY`
- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

## State

`STATE_PATH` peger på den Render persistence disk: `/opt/render/project/src/state/seen.json`.
Den sikrer, at listen over tidligere sete lejligheder bevares mellem genstarter.

## Lokal test

1. Installer dependencies:

```bash
npm install
```

2. Kopier eksempel:

```bash
cp .env.example .env
```

3. Udfyld de hemmelige værdier i `.env`.

4. Start worker lokalt:

```bash
npm start
```

> Det er OK, hvis programmet stopper med en fejl om manglende miljøvariabler under lokal test, så længe der ikke er syntax errors eller manglende imports.

## Environment variables i `.env.example`

- `BASE_URL`
- `RENTALS_API_BASE_URL`
- `RENTALS_API_KEY`
- `STATE_PATH`
- `EMAIL_TO`
- `EMAIL_FROM`
- `EMAIL_SUBJECT_PREFIX`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `MAX_RENT`
- `MIN_ROOMS`
- `POLL_INTERVAL_MS`
- `MONITOR_TIMEZONE`
- `MONITOR_START_HOUR`
- `MONITOR_END_HOUR`
