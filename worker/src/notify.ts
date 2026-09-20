import type { Env, Route, Stats, Analysis } from './types';

const money = (cur: string, n: number) =>
  `${cur === 'USD' ? '$' : cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : cur + ' '}${Math.round(n).toLocaleString('en-US')}`;

const VERDICT_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  book: { label: 'BOOK IT', bg: '#0d7a3e', fg: '#ffffff' },
  watch: { label: 'WATCHING', bg: '#8a6100', fg: '#ffffff' },
  wait: { label: 'HOLD', bg: '#5b5f66', fg: '#ffffff' },
};

export function alertEmail(route: Route, s: Stats, a: Analysis, trigger: string): string {
  const v = VERDICT_STYLE[a.verdict] ?? VERDICT_STYLE.wait;
  const cur = route.currency;
  const delta =
    s.previous !== null
      ? `${s.changeVsPrev <= 0 ? '▼' : '▲'} ${money(cur, Math.abs(s.changeVsPrev))} (${Math.abs(s.changePctVsPrev).toFixed(1)}%) since last check`
      : 'First observation for this route.';

  const row = (k: string, val: string) =>
    `<tr><td style="padding:6px 0;color:#6b7280;font-size:14px">${k}</td>
         <td style="padding:6px 0;text-align:right;font-size:14px;color:#111827;font-weight:600">${val}</td></tr>`;

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb" cellpadding="0" cellspacing="0">
<tr><td style="padding:24px 24px 0">
  <div style="font-size:12px;letter-spacing:1.5px;color:#9ca3af;font-weight:700">SVEL.AI</div>
  <div style="margin-top:14px">
    <span style="display:inline-block;background:${v.bg};color:${v.fg};font-size:11px;font-weight:700;letter-spacing:1px;padding:5px 10px;border-radius:4px">${v.label}</span>
    <span style="color:#9ca3af;font-size:12px;margin-left:8px">${Math.round(a.confidence * 100)}% confidence</span>
  </div>
  <h1 style="margin:14px 0 4px;font-size:20px;color:#111827;line-height:1.3">${a.headline}</h1>
  <div style="color:#6b7280;font-size:14px">${route.origin} → ${route.destination} · ${route.depart_date}${route.return_date ? ` – ${route.return_date}` : ''}</div>
</td></tr>
<tr><td style="padding:20px 24px">
  <div style="font-size:40px;font-weight:700;color:#111827;letter-spacing:-1px">${money(cur, s.current)}</div>
  <div style="color:${s.changeVsPrev <= 0 ? '#0d7a3e' : '#b91c1c'};font-size:14px;margin-top:4px;font-weight:600">${delta}</div>
  <div style="color:#9ca3af;font-size:13px;margin-top:2px">Triggered because it ${trigger}.</div>
</td></tr>
<tr><td style="padding:0 24px">
  <div style="background:#f9fafb;border-radius:8px;padding:14px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${row('Cheapest seen', money(cur, s.min))}
      ${row('Typical (median)', money(cur, s.median))}
      ${row('Most expensive', money(cur, s.max))}
      ${row('Position in range', `${s.percentile.toFixed(0)}th percentile`)}
      ${row('Trend', `${s.trend} (${s.slopePerDay >= 0 ? '+' : ''}${s.slopePerDay.toFixed(1)}/day)`)}
      ${row('Departure', `in ${s.daysToDeparture} days`)}
      ${row('Based on', `${s.samples} checks over ${s.spanDays.toFixed(1)} days`)}
    </table>
  </div>
</td></tr>
<tr><td style="padding:20px 24px 4px">
  <div style="color:#374151;font-size:15px;line-height:1.6">${a.reasoning}</div>
  <div style="margin-top:12px;padding-left:12px;border-left:3px solid #e5e7eb;color:#6b7280;font-size:13px;line-height:1.5"><strong style="color:#374151">What could go wrong:</strong> ${a.risk}</div>
</td></tr>
<tr><td style="padding:20px 24px 24px">
  <a href="${googleFlightsUrl(route)}" style="display:block;background:#111827;color:#ffffff;text-align:center;padding:13px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Open in Google Flights</a>
  <div style="color:#9ca3af;font-size:11px;margin-top:14px;text-align:center;line-height:1.5">Prices are what Google Flights showed at ${new Date().toUTCString()}.<br>Verify before booking — fares move fast.</div>
</td></tr>
</table></body></html>`;
}

export function googleFlightsUrl(route: Route): string {
  const q = route.return_date
    ? `Flights from ${route.origin} to ${route.destination} on ${route.depart_date} through ${route.return_date}`
    : `Flights from ${route.origin} to ${route.destination} on ${route.depart_date}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

export async function sendEmail(
  env: Env,
  subject: string,
  html: string
): Promise<{ ok: boolean; detail: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, detail: 'no RESEND_API_KEY' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [env.ALERT_EMAIL],
      subject,
      html,
    }),
  });
  const detail = await res.text();
  return { ok: res.ok, detail: res.ok ? 'sent' : detail.slice(0, 300) };
}

export async function sendPush(env: Env, title: string, body: string, url: string): Promise<void> {
  if (!env.NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: 'high',
        Tags: 'airplane',
        Click: url,
      },
      body,
    });
  } catch (err) {
    console.error('ntfy failed', err);
  }
}

export async function sendTelegram(env: Env, text: string, chatId?: string): Promise<void> {
  const to = chatId ?? env.TELEGRAM_CHAT_ID;
  if (!env.TELEGRAM_BOT_TOKEN || !to) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: to,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    });
  } catch (err) {
    console.error('telegram failed', err);
  }
}

export function alertTelegram(route: Route, s: Stats, a: Analysis): string {
  const cur = route.currency;
  const arrow = s.changeVsPrev <= 0 ? '▼' : '▲';
  return [
    `<b>${VERDICT_STYLE[a.verdict]?.label ?? 'UPDATE'}</b> · ${Math.round(a.confidence * 100)}%`,
    `<b>${money(cur, s.current)}</b> ${route.origin}→${route.destination}`,
    s.previous !== null
      ? `${arrow} ${money(cur, Math.abs(s.changeVsPrev))} (${Math.abs(s.changePctVsPrev).toFixed(1)}%)`
      : 'first reading',
    ``,
    a.headline,
    `${s.percentile.toFixed(0)}th pct · low ${money(cur, s.min)} · med ${money(cur, s.median)} · ${s.trend}`,
    `Departs in ${s.daysToDeparture}d · ${s.samples} checks`,
    ``,
    `<a href="${googleFlightsUrl(route)}">Open in Google Flights</a>`,
  ].join('\n');
}
