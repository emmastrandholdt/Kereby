# Kereby Render Monitor

Dette repository overvåger `https://kerebyudlejning.dk` via Kerebys offentlige API og sender en mail med direkte links, når der kommer nye lejligheder, som matcher kriterierne.

Aktuel funktion:
- kører som en Render background worker
- poller hvert 15. sekund
- kører kun mellem `08:00` og `16:00` dansk tid
- sender kun notifikationer til `emma.strandholt7000@gmail.com`
- sender kun for lejligheder med husleje på maks `9500` kr
- har intet krav til antal værelser
- gemmer sete lejligheder i `state/seen.json` for at undgå dubletter

## Arkitektur

Løsningen består af én langkørende worker:
- `scripts/monitor.mjs` henter Kerebys lejemål fra API'et, filtrerer dem og sender mail.
- `render.yaml` deployer servicen som en Render `worker`.
- `state/seen.json` ligger på en Render persistent disk, så listen over sete lejligheder overlever restarts og deploys.

Dubletbeskyttelse:
- nye lejligheder bliver skrevet til state-filen med det samme, før mail-send
- state ligger på persistent disk i Render
- der er kun én worker-proces i denne opsætning

## Render setup

Render cron er ikke egnet til 15-sekunders polling. Derfor bruger repoet en `worker` i stedet for en `cron` service.

`render.yaml` forventer disse secrets i Render:
- `RENTALS_API_KEY`
- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`

Render-konfigurationen sætter selv disse faste værdier:
- `EMAIL_TO=emma.strandholt7000@gmail.com`
- `MAX_RENT=9500`
- `MIN_ROOMS=0`
- `POLL_INTERVAL_MS=15000`
- `MONITOR_TIMEZONE=Europe/Copenhagen`
- `MONITOR_START_HOUR=8`
- `MONITOR_END_HOUR=16`
- `STATE_PATH=/opt/render/project/src/state/seen.json`

## Lokal kørsel

1. Installer dependencies:
```bash
npm install
```

2. Opret en lokal `.env`:
```bash
cp .env.example .env
```

3. Udfyld SMTP og `RENTALS_API_KEY` i `.env`.

4. Start worker:
```bash
npm run monitor
```

## Noter

- Render persistent disks virker kun på understøttede betalte services. Render dokumenterer, at workers kan bruge persistent disk, og at mount path for Node-kode under repoet skal ligge under `/opt/render/project/src`.
- Blueprint secrets i `render.yaml` er sat med `sync: false`, som Render anbefaler til credentials.

Kilder:
- https://render.com/docs/blueprint-spec
- https://render.com/docs/disks
- https://render.com/docs/background-workers
