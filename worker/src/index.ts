import type { Env, Route, Offer, Stats } from './types';
import { computeStats, shouldAlert } from './stats';
import { analyze, parseRouteRequest } from './analyze';
import {
  activeRoutes,
  history,
  recordPrice,
  recordAlert,
  alertedRecently,
  recordHealth,
  addRoute,
  deactivateRoute,
  getRoute,
} from './db';
import {
  alertEmail,
  alertTelegram,
  sendEmail,
  sendPush,
  sendTelegram,
  googleFlightsUrl,
} from './notify';
import { buildWeeklyReport } from './report';

/** Don't re-alert the same route inside this window. */
const ALERT_COOLDOWN_HOURS = 6;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function authorized(req: Request, env: Env): boolean {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  // Constant-time-ish: compare full strings, not prefixes.
  return token.length > 0 && token === env.INGEST_TOKEN;
}

interface IngestBody {
  route_id: number;
  ok: boolean;
  error?: string;
  offers?: Offer[];
}

async function handleIngest(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as IngestBody;
  const route = await getRoute(env, body.route_id);
  if (!route) return json({ error: 'unknown route' }, 404);

  if (!body.ok || !body.offers || body.offers.length === 0) {
    await recordHealth(env, 'scraper', false, `route ${route.id}: ${body.error ?? 'no offers'}`);
    return json({ status: 'recorded_failure' });
  }

  const eligible = body.offers.filter(
    (o) => o.price > 0 && (route.max_stops === null || o.stops <= route.max_stops)
  );
  if (eligible.length === 0) {
    await recordHealth(env, 'scraper', false, `route ${route.id}: no offers within stop limit`);
    return json({ status: 'no_eligible_offers' });
  }

  const best = eligible.reduce((a, b) => (b.price < a.price ? b : a));
  await recordPrice(env, route.id, best, eligible);
  await recordHealth(env, 'scraper', true, `route ${route.id}: ${eligible.length} offers`);

  const hist = await history(env, route.id);
  const stats = computeStats(hist, route);
  const trigger = shouldAlert(stats, route);

  if (!trigger.fire) {
    return json({ status: 'stored', price: best.price, alert: false });
  }
  if (await alertedRecently(env, route.id, ALERT_COOLDOWN_HOURS)) {
    return json({ status: 'stored', price: best.price, alert: false, reason: 'cooldown' });
  }

  const analysis = await analyze(env, route, stats);
  const subject = `${analysis.verdict === 'book' ? 'Book' : 'Price drop'}: ${route.origin}→${route.destination} ${route.currency} ${Math.round(stats.current)}`;

  const mail = await sendEmail(env, subject, alertEmail(route, stats, analysis, trigger.reason));
  await sendPush(
    env,
    subject,
    `${analysis.headline} — ${analysis.verdict.toUpperCase()} (${Math.round(analysis.confidence * 100)}%)`,
    googleFlightsUrl(route)
  );
  await sendTelegram(env, alertTelegram(route, stats, analysis));
  await recordAlert(
    env,
    route.id,
    trigger.kind,
    stats.current,
    stats.previous,
    analysis.verdict,
    analysis.confidence,
    analysis.headline
  );
  if (!mail.ok) await recordHealth(env, 'email', false, mail.detail);

  return json({ status: 'alerted', price: best.price, verdict: analysis.verdict });
}

// ---------------------------------------------------------------- Telegram

async function handleTelegram(req: Request, env: Env): Promise<Response> {
  if (
    env.TELEGRAM_SECRET &&
    req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_SECRET
  ) {
    return json({ error: 'forbidden' }, 403);
  }

  const update = (await req.json()) as any;
  const msg = update.message ?? update.edited_message;
  const chatId = msg?.chat?.id?.toString();
  const text: string = (msg?.text ?? '').trim();
  if (!chatId || !text) return json({ ok: true });

  // Only the configured owner may drive the bot.
  if (env.TELEGRAM_CHAT_ID && chatId !== env.TELEGRAM_CHAT_ID) {
    await sendTelegram(env, `Not authorised. Your chat id is <code>${chatId}</code>.`, chatId);
    return json({ ok: true });
  }

  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');

  try {
    switch (cmd.toLowerCase()) {
      case '/start':
      case '/help':
        await sendTelegram(
          env,
          [
            '<b>svel.ai</b>',
            '',
            '/list — tracked routes',
            '/add &lt;plain English&gt; — e.g. <i>/add JFK to Lisbon Mar 3 to Mar 10 under 500</i>',
            '/remove &lt;id&gt; — stop tracking',
            '/status — latest price per route',
            '/report — send the weekly report now',
          ].join('\n'),
          chatId
        );
        break;

      case '/list': {
        const routes = await activeRoutes(env);
        await sendTelegram(
          env,
          routes.length === 0
            ? 'No active routes. Add one with /add.'
            : routes
                .map(
                  (r) =>
                    `<b>#${r.id}</b> ${r.label}\n${r.origin}→${r.destination} ${r.depart_date}${r.return_date ? `–${r.return_date}` : ''}${r.target_price ? ` · target ${r.target_price}` : ''}`
                )
                .join('\n\n'),
          chatId
        );
        break;
      }

      case '/add': {
        if (!arg) {
          await sendTelegram(env, 'Tell me the route, e.g. <i>/add JFK to Lisbon Mar 3 to Mar 10 under 500</i>', chatId);
          break;
        }
        const today = new Date().toISOString().slice(0, 10);
        const parsed = await parseRouteRequest(env, arg, today);
        if (!parsed) {
          await sendTelegram(env, 'Could not parse that (is ANTHROPIC_API_KEY set?).', chatId);
          break;
        }
        if (!parsed.ok) {
          await sendTelegram(env, `I need more: ${parsed.error}`, chatId);
          break;
        }
        const id = await addRoute(env, {
          label: parsed.label,
          origin: parsed.origin,
          destination: parsed.destination,
          depart_date: parsed.depart_date,
          return_date: parsed.return_date || null,
          trip_type: parsed.trip_type,
          seat: parsed.seat,
          adults: parsed.adults,
          target_price: parsed.target_price > 0 ? parsed.target_price : null,
        });
        await sendTelegram(
          env,
          `Tracking <b>#${id}</b> ${parsed.label}\n${parsed.origin}→${parsed.destination} ${parsed.depart_date}${parsed.return_date ? `–${parsed.return_date}` : ''}${parsed.target_price ? `\nTarget ${parsed.target_price}` : ''}\n\nFirst reading lands on the next poll.`,
          chatId
        );
        break;
      }

      case '/remove': {
        const id = parseInt(arg, 10);
        if (Number.isNaN(id)) {
          await sendTelegram(env, 'Usage: /remove 3', chatId);
          break;
        }
        await deactivateRoute(env, id);
        await sendTelegram(env, `Stopped tracking #${id}. Its history is kept.`, chatId);
        break;
      }

      case '/status': {
        const routes = await activeRoutes(env);
        const lines: string[] = [];
        for (const r of routes) {
          const hist = await history(env, r.id);
          if (hist.length === 0) {
            lines.push(`<b>#${r.id}</b> ${r.label} — no readings yet`);
            continue;
          }
          const s = computeStats(hist, r);
          lines.push(
            `<b>#${r.id}</b> ${r.label}\n${r.currency} ${Math.round(s.current)} · ${s.percentile.toFixed(0)}th pct · ${s.trend} · low ${Math.round(s.min)} · ${s.samples} checks`
          );
        }
        await sendTelegram(env, lines.length ? lines.join('\n\n') : 'Nothing tracked yet.', chatId);
        break;
      }

      case '/report': {
        const report = await buildWeeklyReport(env);
        if (!report) {
          await sendTelegram(env, 'No data to report yet.', chatId);
          break;
        }
        const res = await sendEmail(env, report.subject, report.html);
        await sendTelegram(env, res.ok ? 'Report emailed.' : `Email failed: ${res.detail}`, chatId);
        break;
      }

      default:
        await sendTelegram(env, 'Unknown command. /help for the list.', chatId);
    }
  } catch (err) {
    console.error('telegram handler', err);
    await sendTelegram(env, `Something broke: ${String(err).slice(0, 200)}`, chatId);
  }

  return json({ ok: true });
}

// ------------------------------------------------------------------- cron

/** Warns if every scraper run in the last 6h failed. */
async function healthSweep(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(ok) AS good FROM health
      WHERE source = 'scraper' AND checked_at > datetime('now', '-6 hours')`
  ).first<{ total: number; good: number | null }>();

  if (!row || row.total === 0) {
    await sendTelegram(env, '⚠️ svel.ai: no scraper runs in 6 hours. Is the GitHub Action enabled?');
    return;
  }
  if ((row.good ?? 0) === 0) {
    await sendTelegram(
      env,
      `⚠️ svel.ai: all ${row.total} scraper runs failed in the last 6h. Google likely changed their page — update fast-flights, or switch on the SerpAPI fallback.`
    );
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'svel.ai' });
    }

    if (url.pathname === '/telegram' && req.method === 'POST') {
      return handleTelegram(req, env);
    }

    if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);

    if (url.pathname === '/routes' && req.method === 'GET') {
      return json(await activeRoutes(env));
    }
    if (url.pathname === '/ingest' && req.method === 'POST') {
      return handleIngest(req, env);
    }
    if (url.pathname === '/report' && req.method === 'POST') {
      const report = await buildWeeklyReport(env);
      if (!report) return json({ status: 'no_data' });
      return json(await sendEmail(env, report.subject, report.html));
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Weekly report Sundays 08:00 UTC; health sweep on the other firings.
    const d = new Date(event.scheduledTime);
    if (d.getUTCDay() === 0 && d.getUTCHours() === 8) {
      const report = await buildWeeklyReport(env);
      if (report) {
        ctx.waitUntil(sendEmail(env, report.subject, report.html).then(() => undefined));
      }
    } else {
      ctx.waitUntil(healthSweep(env));
    }
  },
};
