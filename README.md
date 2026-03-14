# Kereby-lejlighed overvågning (gratis drift)

Denne løsning overvåger `https://kerebyudlejning.dk` automatisk og sender mail til den adresse, du sætter i `EMAIL_TO`, når der opdages nye lejligheds-links. Mailen indeholder direkte klikbare links.
Notifikation sendes kun, når annoncer matcher dine kriterier (maks husleje og min antal værelser).

## Hvordan den kører gratis "hele tiden"

Løsningen bruger **GitHub Actions** som gratis server:

- Kører hvert 5. minut mellem `08:00` og `16:00` dansk tid.
- Gemmer kendte links i `state/seen.json`.
- Sender kun mail ved nye links, som matcher kriterierne.
- Henter data direkte fra Kerebys tenancies-API (ikke kun HTML-links), så den finder faktiske lejligheder.

## Opsætning

1. Opret et GitHub-repository med disse filer.
2. Gå til `Settings -> Secrets and variables -> Actions` og opret disse secrets:
   - `EMAIL_TO`
   - `SMTP_USER`
   - `SMTP_PASS`
   - `EMAIL_FROM`
3. Aktivér Actions i repoet.
4. Kør workflowet én gang manuelt (`Actions -> Kereby Monitor -> Run workflow`) for baseline.
5. Derefter kører det automatisk hvert 5. minut mellem `08:00` og `16:00` dansk tid.

Bemærk: GitHub Actions schedule er ikke real-time, så der kan være små forsinkelser.

## Gratis SMTP (mailafsender)

Du kan bruge en gratis SMTP-konto, fx:

- Brevo free plan
- Gmail/Outlook SMTP (kræver konto og ofte app-password)

Brug SMTP-oplysningerne som GitHub secrets.

### Brevo (anbefalet)

1. Opret konto på Brevo og verificer afsenderadresse i Brevo.
2. Gå til SMTP/API i Brevo og hent SMTP login + SMTP key.
3. Sæt:
   - `SMTP_HOST=smtp-relay.brevo.com`
   - `SMTP_PORT=587`
   - `SMTP_AUTH_METHOD=password`
   - `SMTP_USER=<Brevo SMTP login>`
   - `SMTP_PASS=<Brevo SMTP key>`

Outlook/Microsoft kræver ofte OAuth2 (Modern Auth), ikke SMTP password.

### Outlook OAuth2 (hurtig opsætning)

1. Opret en App Registration i Azure Portal.
2. Giv delegated permission: `SMTP.Send` (Office 365 Exchange Online).
3. Tilføj redirect URI: `http://localhost`.
4. Opret client secret.
5. Sæt i `.env`:
   - `SMTP_AUTH_METHOD=oauth2`
   - `SMTP_OAUTH_CLIENT_ID`
   - `SMTP_OAUTH_CLIENT_SECRET`
   - `SMTP_OAUTH_TENANT_ID` (`common` eller dit tenant-id)
   - `SMTP_OAUTH_REDIRECT_URI=http://localhost`
6. Hent refresh token:
   - `npm run oauth:refresh`
7. Kør monitor:
   - `npm run monitor`

## Filtrering af notifikationer

Følgende env vars styrer filtrering:

- `MAX_RENT` (default `16000`)
- `MIN_ROOMS` (default `3`)

Hvis en ny annonce ikke kan parses til både husleje og værelser, sendes der ingen notifikation for den.

## Tidsvindue

Følgende env vars styrer hvornår monitoren må køre:

- `MONITOR_TIMEZONE` (default `Europe/Copenhagen`)
- `MONITOR_START_HOUR` (default `8`)
- `MONITOR_END_HOUR` (default `16`)

Monitoren kører kun i dette vindue. Udenfor vinduet stopper scriptet uden at scanne siden.

## Lokalt test (valgfrit)

```bash
npm install
cp .env.example .env
npm run monitor
```

## Vigtige filer

- `scripts/monitor.mjs`: scanner siden og sender mail
- `.github/workflows/kereby-monitor.yml`: gratis drift på GitHub Actions
- `state/seen.json`: gemt state mellem kørsel
