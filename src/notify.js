export function configuredNotifiers(env, { push } = {}) {
  const notifiers = [];
  if (push?.size) {
    notifiers.push({ name: 'push', send: (msg) => push.send(msg) });
  }
  if (env.RESEND_API_KEY && env.EMAIL_TO) {
    notifiers.push({ name: 'email', send: (msg) => sendEmail(env, msg) });
  }
  if (env.NTFY_TOPIC) {
    notifiers.push({ name: 'ntfy', send: (msg) => sendNtfy(env, msg) });
  }
  if (env.DISCORD_WEBHOOK_URL) {
    notifiers.push({ name: 'discord', send: (msg) => sendDiscord(env, msg) });
  }
  return notifiers;
}

export async function notifyAll(notifiers, msg, log = console.log) {
  const results = await Promise.allSettled(notifiers.map((n) => n.send(msg)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') log(`notify via ${notifiers[i].name} failed: ${r.reason?.message ?? r.reason}`);
    else log(`notified via ${notifiers[i].name}`);
  });
  return results.some((r) => r.status === 'fulfilled');
}

async function sendEmail(env, { subject, text, url }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'Apple Stock <onboarding@resend.dev>',
      to: env.EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean),
      subject,
      text: url ? `${text}\n\n${url}` : text,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function sendNtfy(env, { subject, text, url }) {
  const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const headers = { Title: subject, Priority: env.NTFY_PRIORITY || 'urgent', Tags: 'iphone' };
  if (url) headers.Click = url;
  const res = await fetch(`${server}/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: 'POST',
    headers,
    body: text,
  });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
}

async function sendDiscord(env, { subject, text, url }) {
  const content = [`**${subject}**`, text, url].filter(Boolean).join('\n').slice(0, 1900);
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
}
