# svel.ai — build status

Last updated: 2026-09-20.

Flight-price agent: polls Google Flights every 30 minutes, keeps a price history
in D1, and alerts by email + phone push + Telegram when something worth knowing
happens. Architecture and design rationale live in `README.md`.

**Identifiers, URLs and account details are in `PRIVATE-NOTES.md`** (gitignored,
because this repo is public). Secret values are in `.secrets-scratch` (also
gitignored). Neither is in git — if you cloned this repo fresh, you will need to
recreate both.

## Done

- [x] Worker built; typechecks clean; 17 unit tests passing
- [x] Scraper live-tested against Google Flights (returned real prices)
- [x] Cloudflare login; D1 database created; 4 tables created remotely
- [x] All 6 secrets uploaded to Cloudflare
- [x] Worker deployed; both cron triggers registered
- [x] Endpoint auth verified in production (401 unauthenticated, 403 bad
      Telegram secret, 200 with valid token)
- [x] Anthropic API key verified against the live API
- [x] Telegram webhook registered, reporting no errors
- [x] Test alert email sent through Resend (HTTP 200)
- [x] Git remote configured, branch `main`
- [x] `INGEST_TOKEN` rotated 2026-09-20 (see "Credential incident" below)
- [x] Local history squashed to one commit so `NTFY_TOPIC` is not published
- [x] `.gitignore` tightened to `.secrets-scratch*`

## Remaining

1. **Push to GitHub.** No credential is stored on this machine yet, so log in
   first, in a real terminal (it needs a TTY):
   ```bash
   gh auth login     # GitHub.com / HTTPS / Yes to "Authenticate Git" / browser
   cd ~/svel && git push --force -u origin main
   ```
   `--force` is required: the remote's history is unrelated to the local one, so
   a plain push is rejected as non-fast-forward. The push replaces the remote's
   two commits and deletes its `main.yml`.

2. **Add two GitHub Actions secrets** (repo Settings -> Secrets and variables
   -> Actions). Values are in `PRIVATE-NOTES.md` and `.secrets-scratch`:
   - `WORKER_URL`
   - `INGEST_TOKEN` — use the **rotated** value. The old one is dead; pasting
     it makes every poll 401.

3. **Enable Actions**, then run the `svel poll` workflow manually once. It will
   say "No active routes" until step 4 — that is still a successful test,
   because it proves GitHub can authenticate to the Worker.

4. **Add routes** (nothing is monitored until this happens). Either text the
   bot `/add JFK to Lisbon March 3 to March 10 under 500`, or insert directly
   with the SQL below.

## Credential incident (2026-09-20)

The GitHub repo is public, and its `.github/workflows/main.yml` contained the
live `INGEST_TOKEN` hardcoded in a curl command. The token was rotated: a new
one was uploaded with `wrangler secret put` and written to `.secrets-scratch`.
Verified against `GET /routes` — old token 401, new token 200.

The leaked value is dead, so the orphaned commit `c37459e` that still holds it
needs no further action. The matching GitHub Actions secret must be created
with the new value.

## Unverified

- Does `/help` in Telegram get a reply? (tests inbound webhook delivery — the
  one path that cannot be checked from the command line)
- Did the test email actually land, inbox or spam?

## Resuming work

```bash
cd ~/svel && cat STATUS.md

cd worker
npm test                  # 17 tests over the stats/verdict logic
npm run typecheck
npx wrangler deploy       # redeploy after code changes
npx wrangler tail         # live logs from the deployed Worker
npx wrangler secret list
```

Inspect the data (`DB` is the binding; the database name is in PRIVATE-NOTES):

```bash
cd ~/svel/worker
DB=flight-monitor-db
npx wrangler d1 execute $DB --remote --command \
  "SELECT id,label,origin,destination,depart_date,target_price,active FROM routes;"
npx wrangler d1 execute $DB --remote --command \
  "SELECT route_id,observed_at,price FROM price_points ORDER BY id DESC LIMIT 20;"
npx wrangler d1 execute $DB --remote --command \
  "SELECT checked_at,source,ok,detail FROM health ORDER BY id DESC LIMIT 10;"
```

Add a route directly:

```bash
npx wrangler d1 execute flight-monitor-db --remote --command \
  "INSERT INTO routes (label,origin,destination,depart_date,return_date,trip_type,seat,adults,currency,target_price,drop_pct)
   VALUES ('NYC → Lisbon','JFK','LIS','2027-03-03','2027-03-10','round-trip','economy',1,'USD',500,7.0);"
```

Send yourself the weekly report on demand, without waiting for Sunday:

```bash
curl -X POST "$(grep '^WORKER_URL=' ~/svel/.secrets-scratch | cut -d= -f2-)/report" \
  -H "Authorization: Bearer $(grep '^INGEST_TOKEN=' ~/svel/.secrets-scratch | cut -d= -f2-)"
```

## Open question

**Which routes to track has never been decided.** Nothing is monitored until
routes exist. Each one needs an origin, a destination, dates, and optionally a
target price.

## Known risks

- The scraper reads Google Flights' internal protobuf endpoint, so it **will**
  break when Google changes it. The 6-hourly health sweep sends a Telegram
  message if every run failed in that window, so it fails loudly rather than
  silently. Fix order: `pip install -U fast-flights` first; if upstream has not
  caught up, fall back to SerpAPI's free tier (250 searches/month) through the
  library's SearchApi integration.
- Verdicts are computed from this system's own tracked history, so they are
  weak for the first few days on a new route and sharpen over time.
- GitHub queues scheduled Actions under load — "every 30 minutes" is really
  every 30-45 minutes.
- See `PRIVATE-NOTES.md` for outstanding credential rotation.
