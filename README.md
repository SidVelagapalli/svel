# svel.ai

A personal flight-price agent. It polls Google Flights on a schedule, keeps a
price history, and emails you when something actually worth knowing happens.

## How it works

```
GitHub Actions (every 30 min, free)
  └─ scraper/scrape.py ── fast-flights ──> Google Flights
       │
       │  POST /ingest
       ▼
Cloudflare Worker (free tier)
  ├─ D1: full price history per route
  ├─ stats.ts   deterministic: percentile, trend, volatility, drop detection
  ├─ analyze.ts Claude (claude-opus-5) reads those stats, writes the verdict
  └─ notify.ts  Resend email + ntfy push + Telegram
```

**The split matters.** All arithmetic and every alert/no-alert decision happens
in `stats.ts`, in plain TypeScript, under test. Claude never computes a number
and never decides whether to wake you up — it receives already-computed
statistics and writes the explanation and the book/wait call. That's what keeps
the advice accurate: an LLM doing percentile math on prices is how you get
confidently wrong recommendations.

If the Claude API is unreachable, `analyze()` falls back to the rule-based
verdict and the alert still sends.

## When it alerts

Deterministic gate in `shouldAlert()`, in priority order:

1. **Target hit** — price at or below the target you set for that route
2. **Drop** — fell by more than `drop_pct` (default 7%) since the last check
3. **All-time low** — cheapest yet, and only once there are ≥8 observations

Then a 6-hour per-route cooldown so one volatile day can't spam you.

The "balanced" verdict (`baselineVerdict()`): **book** when the price is in the
bottom fifth of its own tracked range and is no longer falling, or when you're
inside 3 weeks of departure at a below-median price.

Trend is measured over a trailing **3-day** window, not all history — otherwise
one step-down weeks ago pins the trend to "falling" forever and it never tells
you to book.

## Setup

### 1. Cloudflare

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create svel          # paste database_id into wrangler.toml
npm run db:init                      # create tables (remote)
```

### 2. Secrets

```bash
cd worker
openssl rand -hex 32                 # use this as INGEST_TOKEN
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY   # console.anthropic.com
npx wrangler secret put RESEND_API_KEY      # resend.com, free tier
npx wrangler secret put TELEGRAM_BOT_TOKEN  # from @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID    # from @userinfobot
npx wrangler secret put TELEGRAM_SECRET     # openssl rand -hex 16
```

Edit `wrangler.toml` → set `NTFY_TOPIC` to something unguessable (it's a public
namespace — anyone who knows the topic can read it). Install the ntfy app and
subscribe to that topic.

```bash
npm run deploy
```

### 3. Telegram webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://svel-ai.<your-subdomain>.workers.dev/telegram" \
  -d "secret_token=<TELEGRAM_SECRET>"
```

### 4. GitHub Actions

Push this repo, then add two repository secrets (Settings → Secrets → Actions):

- `WORKER_URL` — `https://svel-ai.<your-subdomain>.workers.dev`
- `INGEST_TOKEN` — the same value you set on the Worker

Enable Actions, then run the `svel poll` workflow once manually to confirm.

### 5. Add a route

Text your bot:

```
/add JFK to Lisbon March 3 to March 10 under 500
```

Claude parses that into a tracked route. Other commands: `/list`, `/status`,
`/remove <id>`, `/report`, `/help`.

## Email sending

`MAIL_FROM` defaults to Resend's shared `onboarding@resend.dev`, which **only
delivers to the email address that owns the Resend account** — fine here, since
svel only ever emails you. To send from `alerts@svel.ai`, buy the domain, verify
it in Resend, and change `MAIL_FROM` in `wrangler.toml`.

## Running costs

| Item | Cost |
|---|---|
| Cloudflare Workers + D1 | $0 (free tier) |
| GitHub Actions | $0 (public repo) |
| Resend | $0 (3,000 emails/mo) |
| ntfy / Telegram | $0 |
| Claude API | a few cents/mo — only runs on alerts and weekly reports |

Claude is called on `claude-opus-5` at `effort: "low"`. Swap `MODEL` in
`src/analyze.ts` to `claude-haiku-4-5` to cut that further.

## Reliability

The scraper reads Google Flights' internal protobuf endpoint, so **it will break
occasionally** when Google changes things. Mitigations built in:

- Every poll writes a row to the `health` table, success or failure
- A Worker cron sweeps every 6 hours and Telegrams you if *all* scraper runs
  failed in that window, or if no runs happened at all
- `keepalive.yml` commits monthly, because GitHub disables scheduled workflows
  after 60 days of repo inactivity

When it breaks: `pip install -U fast-flights` first. If upstream hasn't caught
up, fall back to SerpAPI's free tier (250 searches/month) — `fast-flights`
supports a SearchApi integration via `get_flights(q, integration=SearchApi())`.

## Development

```bash
cd worker
npm test          # 17 tests over the stats/verdict logic
npm run typecheck
npm run db:init:local
npm run dev
```

## Caveats

- Prices are what Google Flights displayed at poll time. Always verify before
  booking; fares move faster than a 30-minute cadence.
- GitHub's scheduled runners queue under load — "every 30 min" is really
  "every 30–45 min".
- Verdicts come from *your own tracked history*, so they're weak for the first
  few days of a new route and get sharper the longer it runs.
