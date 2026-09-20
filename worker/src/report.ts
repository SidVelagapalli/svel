import type { Env, Route, Stats } from './types';
import { computeStats, baselineVerdict } from './stats';
import { activeRoutes, history } from './db';
import { googleFlightsUrl } from './notify';

const money = (cur: string, n: number) =>
  `${cur === 'USD' ? '$' : cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : cur + ' '}${Math.round(n).toLocaleString('en-US')}`;

/** Inline SVG sparkline — renders in most mail clients without external assets. */
function sparkline(points: number[], w = 200, h = 40): string {
  if (points.length < 2) return '';
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(h - ((p - min) / span) * h).toFixed(1)}`);
  const last = points[points.length - 1];
  const cx = w;
  const cy = h - ((last - min) / span) * h;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <polyline points="${coords.join(' ')}" fill="none" stroke="#111827" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="#0d7a3e"/>
  </svg>`;
}

export async function buildWeeklyReport(env: Env): Promise<{ subject: string; html: string } | null> {
  const routes = await activeRoutes(env);
  if (routes.length === 0) return null;

  const cards: string[] = [];
  let anyData = false;

  for (const route of routes) {
    const hist = await history(env, route.id);
    if (hist.length === 0) {
      cards.push(`<tr><td style="padding:16px 24px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:14px">
        ${route.label} — no readings yet.</td></tr>`);
      continue;
    }
    anyData = true;
    const s: Stats = computeStats(hist, route);
    const base = baselineVerdict(s);
    const week = hist.filter(
      (p) => Date.parse(p.observed_at + 'Z') > Date.now() - 7 * 86_400_000
    );
    const weekPrices = (week.length > 1 ? week : hist).map((p) => p.price);
    const weekChange = weekPrices.length > 1 ? weekPrices[weekPrices.length - 1] - weekPrices[0] : 0;
    const cur = route.currency;

    cards.push(`<tr><td style="padding:18px 24px;border-top:1px solid #f3f4f6">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:top">
          <div style="font-size:15px;font-weight:700;color:#111827">${route.label}</div>
          <div style="color:#9ca3af;font-size:12px;margin-top:2px">${route.origin}→${route.destination} · departs in ${s.daysToDeparture}d</div>
          <div style="font-size:26px;font-weight:700;color:#111827;margin-top:8px">${money(cur, s.current)}</div>
          <div style="font-size:13px;color:${weekChange <= 0 ? '#0d7a3e' : '#b91c1c'};font-weight:600">
            ${weekChange === 0 ? 'flat this week' : `${weekChange < 0 ? '▼' : '▲'} ${money(cur, Math.abs(weekChange))} this week`}
          </div>
          <div style="font-size:12px;color:#6b7280;margin-top:6px">
            low ${money(cur, s.min)} · med ${money(cur, s.median)} · high ${money(cur, s.max)}<br>
            ${s.percentile.toFixed(0)}th percentile · trend ${s.trend} · ${s.samples} checks
          </div>
          <div style="font-size:13px;color:#374151;margin-top:8px"><strong>${base.verdict.toUpperCase()}</strong> — ${base.why}</div>
        </td>
        <td style="vertical-align:top;text-align:right;width:210px">${sparkline(hist.map((p) => p.price))}</td>
      </tr></table>
      <a href="${googleFlightsUrl(route)}" style="display:inline-block;margin-top:10px;color:#111827;font-size:13px;font-weight:600;text-decoration:underline">Open in Google Flights</a>
    </td></tr>`);
  }

  if (!anyData) return null;

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb" cellpadding="0" cellspacing="0">
<tr><td style="padding:24px 24px 18px">
  <div style="font-size:12px;letter-spacing:1.5px;color:#9ca3af;font-weight:700">SVEL.AI</div>
  <h1 style="margin:10px 0 2px;font-size:20px;color:#111827">Weekly pattern report</h1>
  <div style="color:#6b7280;font-size:13px">${routes.length} route${routes.length === 1 ? '' : 's'} tracked · ${new Date().toDateString()}</div>
</td></tr>
${cards.join('\n')}
<tr><td style="padding:18px 24px 24px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:11px;line-height:1.5">
  Verdicts come from your own tracked history, not from outside forecasts. The longer svel runs, the sharper they get.
</td></tr>
</table></body></html>`;

  return { subject: `svel.ai — weekly report (${routes.length} route${routes.length === 1 ? '' : 's'})`, html };
}
