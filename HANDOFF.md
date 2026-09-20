# svel.ai — handoff for an assisting agent

Written 2026-09-20. Read this together with `STATUS.md`.

You are picking up a working, deployed flight-price monitor. Almost everything
is done and verified. **One step is blocked**, and it is blocked for a reason
you cannot engineer around. Read "The blocker" before trying anything.

---

## What this project is

A Cloudflare Worker (`svel-ai`) that stores flight price history in D1 and
alerts by email / phone push / Telegram. A Python scraper polls Google Flights
and POSTs offers to the Worker's `/ingest` endpoint. GitHub Actions runs the
scraper on a cron every 30 minutes.

Repo: `~/svel`, public at `github.com/SidVelagapalli/svel`.

---

## Verified working (do not redo these)

| Thing | Evidence |
|---|---|
| Worker deployed, cron triggers registered | `npx wrangler deploy` succeeded |
| D1 `flight-monitor-db`, 4 tables | queried remotely, returns rows |
| Endpoint auth | `GET /routes` -> 401 without token, 200 with |
| `INGEST_TOKEN` rotated 2026-09-20 | old value 401, new value 200 |
| Route 1 live | JFK->LIS, 2027-03-03/2027-03-10, target USD 500 |
| Full pipeline | scraper ran locally: 4 offers, cheapest USD 668, stored |
| `price_points` row | `route_id 1, 2026-09-20 16:33:57, 668` |
| `health` row | `scraper, ok=1, "route 1: 4 offers"` |
| Local git | 3 commits on `main`, scanned clean of secrets |

Secrets live in `~/svel/.secrets-scratch` (gitignored, chmod 600). Non-secret
identifiers live in `~/svel/PRIVATE-NOTES.md` (gitignored). Neither is tracked.

---

## The blocker

`git push` is rejected:

```
! [remote rejected] main -> main
  refusing to allow a Personal Access Token to update workflow
  `.github/workflows/keepalive.yml` without `workflow` scope
```

The repo contains `.github/workflows/poll.yml` and `keepalive.yml`. GitHub
requires the **`workflow`** scope on the credential for any push that touches
files under `.github/workflows/`. The currently stored credential has
`gist, read:org, repo` — no `workflow`.

There is a second, independent reason the push is stuck: `gh auth login`,
`gh auth refresh` and `git push` over HTTPS all need an interactive terminal.

### What does NOT work — already tried, do not repeat

1. Running `gh auth login` from an agent shell. Its prompts read keystrokes
   from a TTY and ignore piped stdin.
2. Wrapping it in `script -q /dev/null` to fake a pty. Tried twice. The first
   run died at the `Authenticate Git with your GitHub credentials? (Y/n)`
   prompt on EOF; the second echoed `Y` but the TUI ignored it.
3. `gh auth refresh -s workflow` under a pty. Hung with no output, had to be
   killed. It never printed a device code.
4. Re-running `git push` without fixing the scope. Fails identically every
   time. Check `gh auth status | grep scopes` before attempting a push.

**Conclusion: the human must run one command in a real terminal.** Do not burn
their time rediscovering this.

---

## Step 1 — the human runs this (Terminal.app, not an agent shell)

```bash
gh auth login --web --clipboard -s workflow
```

It will report an existing login; choose to re-authenticate. Answers:

- account: **GitHub.com**
- protocol: **HTTPS**
- Authenticate Git with your GitHub credentials: **Yes**
- method: **Login with a web browser**

`--clipboard` copies the one-time code. Press Enter, the browser opens
`github.com/login/device`, paste the code, click Authorize.

Confirm before continuing:

```bash
gh auth status | grep scopes     # must now include 'workflow'
```

If `workflow` is absent, the push will fail. Do not proceed.

---

## Step 2 — push (an agent can run this)

```bash
cd ~/svel && git push --force -u origin main
```

`--force` is required. The remote's history is unrelated to the local one
(no common ancestor), so a plain push is rejected as non-fast-forward. The
push replaces the remote's 2 commits and deletes its `.github/workflows/main.yml`.

Verify:

```bash
git ls-remote --heads origin              # should match local HEAD
gh api repos/SidVelagapalli/svel/contents/.github/workflows --jq '.[].name'
                                          # expect poll.yml, keepalive.yml; NOT main.yml
```

---

## Step 3 — GitHub Actions secrets (human, web UI)

Repo -> Settings -> Secrets and variables -> Actions -> New repository secret.
Create exactly two. `scraper/scrape.py` reads only these:

- `WORKER_URL`
- `INGEST_TOKEN`

Values are in `~/svel/.secrets-scratch`. Copy without displaying them:

```bash
grep '^WORKER_URL='   ~/svel/.secrets-scratch | cut -d= -f2- | tr -d '\n' | pbcopy
grep '^INGEST_TOKEN=' ~/svel/.secrets-scratch | cut -d= -f2- | tr -d '\n' | pbcopy
```

**Use the current `INGEST_TOKEN` from that file.** It was rotated 2026-09-20.
An older value appears in the repo's git history; it is dead and will 401.

---

## Step 4 — enable Actions and test

Actions tab -> enable workflows -> run **svel poll** manually.

Expected: `Polling 1 route(s)`, one route succeeding, a price stored. It should
NOT say "No active routes" — a route exists. If it 401s, the `INGEST_TOKEN`
secret does not match the Worker's.

---

## Step 5 — outstanding security task (human)

A GitHub classic PAT created 2026-09-20 was exposed in plaintext in a chat
transcript. It carries `repo` scope. **Revoke it:**

https://github.com/settings/tokens -> find it -> Delete

This is unrelated to the `INGEST_TOKEN` rotation, which is already complete.

---

## Still unverified (needs a phone, not a terminal)

- Does `/help` to the Telegram bot get a reply? Tests inbound webhook delivery.
- Did the earlier Resend test email land, inbox or spam?

Neither was exercised by the local poll run, because USD 668 is above the
USD 500 target so no alert fired.

---

## Useful commands

```bash
cd ~/svel/worker
npm test                                    # 17 tests
npx wrangler tail                           # live Worker logs
npx wrangler d1 execute flight-monitor-db --remote --command \
  "SELECT route_id,observed_at,price FROM price_points ORDER BY id DESC LIMIT 20;"
```

Run the scraper locally (venv already created at `~/svel/.venv`):

```bash
cd ~/svel
export WORKER_URL=$(grep '^WORKER_URL=' .secrets-scratch | cut -d= -f2-)
export INGEST_TOKEN=$(grep '^INGEST_TOKEN=' .secrets-scratch | cut -d= -f2-)
.venv/bin/python scraper/scrape.py
```

---

## Rules for the assisting agent

1. Never ask the human to paste a token, password or API key into chat. It has
   already happened once this session and burned a credential. If a secret is
   needed, have them write it to a gitignored file or somewhere outside the
   repo, then read it from there without echoing it.
2. Never print values from `.secrets-scratch`.
3. Scan before pushing: no value from `.secrets-scratch` may appear in any
   tracked file or commit. `NTFY_TOPIC` in particular must stay out of the
   public repo — local history was squashed specifically to remove it.
4. Do not retry a failing command unchanged. Check the precondition instead
   (`gh auth status`, `git ls-remote`).
