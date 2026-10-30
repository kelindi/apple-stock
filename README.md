# apple-stock

Get pinged the moment an Apple product can be picked up at a store near you, or sent by Apple's 2-hour courier delivery.

It was built for the iPhone Duo on apple.com/ca and works for every iPhone, iPad, Mac, Studio Display and AirPods model in the store (Apple Watch isn't supported yet). It works in the US and Canadian Apple Stores: pick the country in the UI (ZIP codes and miles for the US). Pick a product from the menu in the UI and narrow it down by colour, storage, size, chip or connectivity. For Macs, only the standard configurations that stores keep in stock are listed. Custom build-to-order Macs always ship from Apple.

## How it works

Every couple of minutes it:

1. **Opens the product page** in a hidden Chrome browser, e.g. `apple.com/ca/shop/buy-iphone/iphone-duo`. The page lists every model with its part number, colour, storage and price, and the UI is built from that list.
2. **Asks Apple's stock API** (`/shop/fulfillment-messages`), the same one the Apple Store website uses, about each model near your postal code:
   - **Pickup**: is it available at an Apple Store within `MAX_DISTANCE_KM`?
   - **Courier**: can it be delivered by 2-hour courier?

   Apple blocks scripts that call this API directly (they get error `541`). Calling it from inside the real page gets past that.
3. **Compares with last time** (saved in `.state.json`). If something went from unavailable to available, it notifies you. You get one alert per item, and you'll get another if it sells out and comes back.

```
src/index.js    starts everything: the check loop and the web UI
src/apple.js    talks to apple.com: product menu, product pages, stock API
src/parse.js    turns Apple's pages and API replies into models and availability
src/checker.js  settings, filters, "what's new since last check", notifications
src/notify.js   email, ntfy and Discord; src/push.js is phone/browser push
src/server.js   the local web UI (src/ui.html) and its small API
```

## Adding a new device to track

**New models in a category it already covers** (a new iPhone, iPad, Mac or AirPods) need no work. On every start, the menu is rebuilt from Apple's own store pages.

**A new category** (e.g. Apple Watch or Vision Pro) is one row in `CATEGORIES` at the top of [`src/apple.js`](src/apple.js):

```js
{ id: 'buy-vision', index: 'shop/buy-vision', link: /shop\/buy-vision\/([a-z0-9-]+)/g },
```

- `id`: the part of the store URL before the model, as in `apple.com/ca/shop/buy-vision/apple-vision-pro`.
- `index`: a page that links to every model in that category.
- `link`: the pattern of those links; the bit in brackets is the model name.

Then restart and check that it shows up in the menu.

If it doesn't, Apple's product page uses a layout the app can't read yet. `parseCatalog` in [`src/parse.js`](src/parse.js) reads the two layouts Apple uses today:
- iPhone/iPad/AirPods pages: `displayValues` + `products[].partNumber`.
- Mac pages: `mainDisplayValues` + `products[].btrOrFdPartNumber`.

A new layout needs a function like `parseMacCatalog` that returns the same shape: a `title`, the option `dimensions`, and `models` with a part number, chosen options, image and price. To see what the page contains, run `productSelectionData(html)` on it. Then add a trimmed copy of the page to `test/fixtures/` with a test (`npm test`).

You can also skip the UI and set `PRODUCT=buy-vision/apple-vision-pro` in `.env`.

## Run it at home (recommended)

A computer that stays on is the best option. It has a home IP, checks run on time, and the default is one check every 2 minutes.

```sh
git clone https://github.com/kelindi/apple-stock && cd apple-stock
npm install
npx playwright install chromium
cp .env.example .env          # fill in POSTAL_CODE and a notifier
npm run test-notify           # sends a test notification
npm start                     # checks every INTERVAL_SECONDS until stopped
```

To run a single check: `npm run check`. Add `-- --dry-run` to log results without notifying or saving state.

Then open http://localhost:4321 to pick the country, model, colours, storage and postal/ZIP code.

**On your phone:** browsers only allow push notifications on HTTPS pages, so the phone needs an HTTPS link to the computer. The easiest private way is [Tailscale](https://tailscale.com): install it on both devices, run `tailscale serve --bg 4321` on the computer, and open the `https://<computer>.<tailnet>.ts.net` link it prints. Don't expose the UI on the public internet: anyone who can open it can change the settings.

To keep it running after reboots, see [`examples/com.apple-stock.plist`](examples/com.apple-stock.plist) (macOS launchd) or [`examples/apple-stock.service`](examples/apple-stock.service) (Linux systemd).

## Run it on GitHub Actions

For when you don't have a computer that's always on.

1. Fork this repo. Scheduled workflows are free on public repos.
2. Under **Settings → Secrets and variables → Actions**:
   - Add the **variable** `POSTAL_CODE`, plus `MODELS`, `MAX_DISTANCE_KM`, `COUNTRY` or `PRODUCT` if you want something other than the defaults.
   - Add the **secrets** for your notifier: `RESEND_API_KEY` + `EMAIL_TO` (+ `EMAIL_FROM`), `NTFY_TOPIC` or `DISCORD_WEBHOOK_URL`.
3. Under **Actions**, enable workflows and run **Check stock** once by hand to confirm it works.

The workflow is scheduled every 5 minutes, but GitHub often starts scheduled runs late, and it turns off schedules after 60 days without commits. For on-time checks, have a free cron service such as [cron-job.org](https://cron-job.org) call `POST https://api.github.com/repos/<you>/apple-stock/actions/workflows/check.yml/dispatches` with body `{"ref":"main"}` and a fine-grained token that has Actions read/write on the fork.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `POSTAL_CODE` | (required) | Location used for store search and courier delivery, e.g. `M5V3L9` |
| `COUNTRY` | `ca` | Starting Apple Store country (`ca` or `us`, switchable in the UI; other paths like `uk` or `au` work from here) |
| `PRODUCT` | `iphone-duo` | Store page path, e.g. `buy-iphone/iphone-17`, `buy-ipad/ipad-air`, `buy-mac/macbook-air`, `buy-airpods/airpods-pro-3` (a bare slug means `buy-iphone/<slug>`) |
| `MODELS` | `all` | Comma-separated part numbers or words that must all appear in the model name, e.g. `256GB Night Sky, 512GB` |
| `MAX_DISTANCE_KM` | `50` | Ignore stores farther than this |
| `INTERVAL_SECONDS` | `30` | Time between checks for `npm start` (minimum 30, with ±15% jitter) |
| `STATE_FILE` | `.state.json` | Where the last seen availability is stored |
| `HISTORY_FILE` | `history.json` | Every time something came into stock and how long it lasted, shown under **History** in the UI |
| `HEADLESS` | `true` | Set to `false` to watch the browser |

### Notifiers

Configure any combination of these:

- **Phone/desktop notifications** (built in, free, no account): open the UI and tap **Turn on notifications**. On iPhone (iOS 16.4+), open the page in Safari, tap Share → **Add to Home Screen**, open it from the home screen, then turn notifications on. Alerts are sent with standard Web Push, so they arrive even when the app is closed. Keys are generated into `.vapid.json` on first run (or set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`), and devices are saved in `subscriptions.json`.
- **Email** via [Resend](https://resend.com) (free tier: 3,000 emails/month): `RESEND_API_KEY`, `EMAIL_TO` (comma-separated), and optionally `EMAIL_FROM`. Without a verified domain, Resend only delivers to the email on your Resend account, using the default `onboarding@resend.dev` sender.
- **Push** via [ntfy](https://ntfy.sh) (free app for iPhone/Android): tap **Get alerts in the ntfy app** in the UI. It picks a random topic; subscribe to that topic in the app (or tap **Subscribe**) and tap **Test**. Anyone who knows the topic can read it, so keep it random. You can also set `NTFY_TOPIC` (plus `NTFY_SERVER` if you self-host). Stock alerts are sent as `urgent`; set `NTFY_PRIORITY` (e.g. `high`) to change that. Tapping an alert opens the page for that exact model.
- **Discord**: `DISCORD_WEBHOOK_URL` from a channel's Integrations → Webhooks.

## Caveats

This uses Apple's undocumented storefront endpoints, which can change without notice. Be gentle: checking every couple of minutes is plenty. This project is not affiliated with Apple.
