import { Checker } from './checker.js';
import { configuredNotifiers, notifyAll } from './notify.js';
import { PushStore } from './push.js';
import { startServer } from './server.js';

const args = new Set(process.argv.slice(2));
const env = process.env;
const log = (...m) => console.log(new Date().toISOString(), ...m);

async function main() {
  const push = await new PushStore({
    env,
    keysFile: env.VAPID_FILE || '.vapid.json',
    subscriptionsFile: env.SUBSCRIPTIONS_FILE || 'subscriptions.json',
    log,
  }).init();

  if (args.has('--test-notify')) {
    const notifiers = configuredNotifiers(env, { push });
    if (notifiers.length === 0) {
      throw new Error('No notifier configured; turn on notifications in the UI or set RESEND_API_KEY+EMAIL_TO, NTFY_TOPIC or DISCORD_WEBHOOK_URL');
    }
    const ok = await notifyAll(notifiers, { subject: 'apple-stock test notification', text: 'Notifications are working.' }, log);
    process.exit(ok ? 0 : 1);
  }

  const once = args.has('--once');
  const checker = new Checker({
    env,
    settingsFile: env.SETTINGS_FILE || 'settings.json',
    stateFile: env.STATE_FILE || '.state.json',
    historyFile: env.HISTORY_FILE || 'history.json',
    headless: env.HEADLESS !== 'false',
    dryRun: args.has('--dry-run'),
    log,
    push,
  });
  await checker.init();
  if (checker.notifiers().length === 0) log('no notifier yet: turn on notifications in the UI or configure one in .env');

  if (once) {
    await checker.check();
    await checker.close();
    if (checker.error) process.exit(1);
    return;
  }

  const intervalMs = Math.max(30, Number(env.INTERVAL_SECONDS || 30)) * 1000;
  let timer;
  const schedule = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await checker.check();
      schedule(intervalMs * (0.85 + Math.random() * 0.3));
    }, delay);
  };

  if (!args.has('--no-ui')) {
    startServer(checker, {
      host: env.HOST || '127.0.0.1',
      port: Number(env.PORT || 4321),
      log,
      onSettingsChanged: () => schedule(0),
    });
  }
  schedule(0);

  const shutdown = async () => {
    clearTimeout(timer);
    await checker.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
