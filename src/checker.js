import { readFile, writeFile } from 'node:fs/promises';
import { AppleStore, COUNTRIES, normalizeCountry, normalizeProduct, productName } from './apple.js';
import { availabilityKeys, parseCatalog, parseFulfillment, parseProducts, productSelectionData, selectProducts, shortPickupQuote } from './parse.js';
import { configuredNotifiers, notifyAll } from './notify.js';
import { loadState, saveState } from './state.js';
import { loadHistory, saveHistory, updateHistory } from './history.js';

const SETTING_KEYS = ['country', 'product', 'model', 'filters', 'postalCode', 'maxDistanceKm', 'emailTo', 'ntfyTopic'];

export function defaultSettings(env) {
  return {
    country: normalizeCountry(env.COUNTRY || 'ca'),
    product: normalizeProduct(env.PRODUCT || 'iphone-duo'),
    model: env.MODELS || 'all',
    filters: {},
    postalCode: normalizePostalCode(env.POSTAL_CODE),
    maxDistanceKm: Number(env.MAX_DISTANCE_KM || 50),
    emailTo: env.EMAIL_TO || '',
    ntfyTopic: env.NTFY_TOPIC || '',
  };
}

export function normalizeTopic(value) {
  const topic = String(value ?? '').trim().split('/').pop();
  if (topic && !/^[\w-]{1,64}$/.test(topic)) throw new Error('ntfy topics can only use letters, numbers, - and _');
  return topic;
}

export function normalizePostalCode(value) {
  return String(value ?? '').replace(/\s+/g, '').toUpperCase();
}

const POSTAL_FORMATS = { ca: /^[A-Z]\d[A-Z]\d[A-Z]\d$/, us: /^\d{5}(-\d{4})?$/ };

export function postalCodeFits(code, country) {
  return !POSTAL_FORMATS[country] || POSTAL_FORMATS[country].test(code);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(0, 20) : [];
}

function normalizeFilters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => /^dimension\w{1,40}$/.test(k))
      .slice(0, 12)
      .map(([k, v]) => [k, stringList(v)])
      .filter(([, v]) => v.length),
  );
}

export function matchesFilters(model, filters = {}) {
  return Object.entries(filters).every(([dim, wanted]) => !wanted.length || !(dim in model.dims) || wanted.includes(model.dims[dim]));
}

export function filterVariants(products, variants, filters) {
  if (!variants) return products;
  const byPart = new Map(variants.models.map((m) => [m.partNumber, m]));
  return products.filter((p) => {
    const v = byPart.get(p.partNumber);
    return !v || matchesFilters(v, filters);
  });
}

// Some pages (AirPods) have no metrics list, so names come from the selector options.
export function modelsFromVariants(variants) {
  const names = new Map(variants.dimensions.flatMap((d) => d.options.map((o) => [`${d.key}:${o.key}`, o.name])));
  return variants.models.map((m) => {
    const parts = Object.entries(m.dims).map(([k, v]) => names.get(`${k}:${v}`)).filter(Boolean);
    let name = parts.join(' ');
    if (variants.title && !name.startsWith(variants.title)) name = `${variants.title} ${name}`.trim();
    return { partNumber: m.partNumber, name: name || m.partNumber, price: m.price };
  });
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class Checker {
  constructor({ env, settingsFile, stateFile, historyFile, headless, dryRun, log, push }) {
    this.env = env;
    this.push = push;
    this.settingsFile = settingsFile;
    this.stateFile = stateFile;
    this.historyFile = historyFile;
    this.history = [];
    this.headless = headless;
    this.dryRun = dryRun;
    this.log = log;
    this.settings = defaultSettings(env);
    this.products = [];
    this.catalog = [];
    this.variants = null;
    this.productImages = {};
    this.models = [];
    this.lastChecked = null;
    this.error = null;
    this.checking = null;
    this.settingsUpdate = null;
  }

  async init() {
    if (this.settingsFile) {
      try {
        const saved = pick(JSON.parse(await readFile(this.settingsFile, 'utf8')));
        Object.assign(this.settings, saved, {
          country: normalizeCountry(saved.country ?? this.settings.country),
          product: normalizeProduct(saved.product ?? this.settings.product),
        });
      } catch (err) {
        if (err.code !== 'ENOENT') this.log(`ignoring ${this.settingsFile}: ${err.message}`);
      }
    }
    if (this.historyFile) {
      this.history = await loadHistory(this.historyFile).catch((err) => {
        this.log(`ignoring ${this.historyFile}: ${err.message}`);
        return [];
      });
    }
    this.store = new AppleStore({ country: this.settings.country, product: this.settings.product, headless: this.headless, log: this.log });
    await Promise.all([this.loadProducts(), this.loadVariants()]);
  }

  async loadProducts() {
    const products = await this.store.listProducts().catch((err) => {
      this.log(`product list: ${err.message}`);
      return [];
    });
    for (const p of products) if (p.image) this.productImages[p.slug] ??= p.image;
    this.products = products.map(({ slug, name }) => ({ slug, name }));
  }

  async loadVariants(html) {
    html ??= await this.store.fetchPage().catch((err) => {
      this.log(`catalog: ${err.message}`);
      return null;
    });
    const variants = html ? parseCatalog(html) : null;
    if (!variants) return;
    this.variants = variants;
    Object.assign(this.productImages, variants.productImages);
  }

  updateSettings(input) {
    const previousUpdate = this.settingsUpdate;
    const previousCheck = this.checking;
    const update = (async () => {
      if (previousUpdate) await previousUpdate.catch(() => {});
      if (previousCheck) await previousCheck;
      return this.applySettings(input);
    })();
    this.settingsUpdate = update;
    const clear = () => {
      if (this.settingsUpdate === update) this.settingsUpdate = null;
    };
    update.then(clear, clear);
    return update;
  }

  async applySettings(input) {
    const next = { ...this.settings, ...pick(input) };
    next.country = normalizeCountry(next.country);
    next.postalCode = normalizePostalCode(next.postalCode);
    next.maxDistanceKm = Number(next.maxDistanceKm) || this.settings.maxDistanceKm;
    next.emailTo = String(next.emailTo ?? '').trim();
    next.ntfyTopic = normalizeTopic(next.ntfyTopic);
    next.product = normalizeProduct(next.product);
    next.filters = normalizeFilters(next.filters);
    const countryChanged = next.country !== this.settings.country;
    if (countryChanged) {
      // Part numbers, stores and the product menu all differ between countries.
      if (!postalCodeFits(next.postalCode, next.country)) next.postalCode = '';
      this.products = [];
      this.productImages = {};
      if (this.store) {
        await this.store.close().catch(() => {});
        this.store.browser = undefined;
        this.store.country = next.country;
        await this.loadProducts();
        if (this.products.length && !this.products.some((p) => p.slug === next.product)) next.product = this.products[0].slug;
      }
    }
    const productChanged = countryChanged || next.product !== this.settings.product;
    if (productChanged) {
      Object.assign(next, { model: 'all', filters: {} });
      this.catalog = [];
      this.variants = null;
      this.models = [];
    }
    const changed = SETTING_KEYS.some((k) => JSON.stringify(next[k]) !== JSON.stringify(this.settings[k]));
    this.settings = next;
    if (this.settingsFile) await writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2) + '\n');
    if (productChanged && this.store) {
      this.store.product = next.product;
      await this.loadVariants();
    }
    return changed;
  }

  notifiers() {
    return configuredNotifiers(
      { ...this.env, EMAIL_TO: this.settings.emailTo, NTFY_TOPIC: this.settings.ntfyTopic },
      { push: this.push },
    );
  }

  async testNotifier(name) {
    const notifier = this.notifiers().find((n) => n.name === name);
    if (!notifier) throw new Error(`${name} is not set up`);
    await notifier.send({ subject: 'Notifications are on', text: 'You’ll get an alert here when it’s in stock.' });
  }

  snapshot() {
    const products = this.products.length ? [...this.products] : [];
    if (!products.some((p) => p.slug === this.settings.product)) {
      products.push({ slug: this.settings.product, name: this.variants?.title ?? productName(this.settings.product) });
    }
    return {
      settings: this.settings,
      products,
      catalog: this.catalog,
      variants: this.variants,
      productImages: this.productImages,
      models: this.models,
      history: this.history.slice(-100).reverse(),
      checking: Boolean(this.checking),
      lastChecked: this.lastChecked,
      error: this.error,
      emailEnabled: Boolean(this.env.RESEND_API_KEY),
      pushEnabled: Boolean(this.push),
      countries: Object.entries(COUNTRIES).map(([id, c]) => ({ id, name: c.name, postal: c.postal, locale: c.locale })),
      ntfyServer: (this.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''),
    };
  }

  check() {
    const pendingUpdate = this.settingsUpdate;
    this.checking ??= (async () => {
      if (pendingUpdate) await pendingUpdate.catch(() => {});
      await this.runCheck();
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async runCheck() {
    try {
      await this.checkOnce();
      this.error = null;
    } catch (err) {
      this.error = err.message;
      this.log(`check failed: ${err.message}`);
      await this.store?.close().catch(() => {});
      this.store.browser = undefined;
    }
  }

  async checkOnce() {
    const { product, model, postalCode, maxDistanceKm } = this.settings;
    if (!postalCode || !postalCodeFits(postalCode, this.settings.country)) {
      throw new Error(`enter a valid ${(COUNTRIES[this.settings.country]?.postal ?? 'postal code').toLowerCase()}`);
    }
    const store = this.store;
    store.product = product;
    if (!store.browser) await store.open();

    await store.loadProductPage();
    await this.loadVariants(store.html);
    let catalog = parseProducts(store.html);
    if (catalog.length === 0 && this.variants) catalog = modelsFromVariants(this.variants);
    if (catalog.length === 0) throw new Error(`no models found on ${store.productUrl}`);
    this.catalog = catalog;
    const selected = selectProducts(filterVariants(catalog, this.variants, this.settings.filters), model);
    if (selected.length === 0) throw new Error(`no ${productName(product)} model matches`);

    const results = { pickup: [], delivery: [] };
    for (const batch of chunk(selected.map((p) => p.partNumber), 10)) {
      const parsed = parseFulfillment(await store.fetchFulfillment(batch, postalCode), { maxDistanceKm, country: this.settings.country });
      results.pickup.push(...parsed.pickup);
      results.delivery.push(...parsed.delivery);
    }

    this.models = summarize(selected, results);
    this.lastChecked = new Date().toISOString();

    const names = new Map(catalog.map((p) => [p.partNumber, p.name]));
    const current = availabilityKeys(results);
    const previous = await loadState(this.stateFile);
    const fresh = [...current.keys()].filter((k) => !previous.has(k));
    if (this.historyFile && !this.dryRun) {
      const checked = new Set(selected.map((p) => p.partNumber));
      this.history = updateHistory(this.history, current, { checked, names, now: this.lastChecked });
      await saveHistory(this.historyFile, this.history);
    }
    const stores = new Set(results.pickup.map((p) => p.storeName));
    const sample = results.pickup[0]?.quote || results.delivery[0]?.courierText || '';
    this.log(
      `checked ${selected.length} model(s) at ${stores.size} store(s) within ${this.settings.country === 'us' ? `${Math.round(maxDistanceKm / 1.609344)} mi` : `${maxDistanceKm} km`} of ${postalCode}: ` +
        `${current.size} available, ${fresh.length} new${sample ? ` (e.g. "${sample}")` : ''}`,
    );

    let delivered = true;
    if (fresh.length > 0) {
      const items = fresh.map((k) => current.get(k));
      const message = buildMessage(items, names, modelUrl(store.html, store.productUrl, items[0].partNumber));
      this.log(`${message.subject}\n${message.text}`);
      const notifiers = this.notifiers();
      if (!this.dryRun && notifiers.length > 0) delivered = await notifyAll(notifiers, message, this.log);
    }

    // If every notifier failed, leave the new keys out of the saved state so they are retried next check.
    const saved = delivered ? [...current.keys()] : [...current.keys()].filter((k) => previous.has(k));
    if (!this.dryRun) await saveState(this.stateFile, saved);
  }

  async close() {
    await this.store?.close();
  }
}

export function summarize(selected, { pickup, delivery }) {
  return selected.map((p) => {
    const stores = pickup.filter((s) => s.partNumber === p.partNumber && s.available);
    const courier = delivery.find((d) => d.partNumber === p.partNumber);
    const parts = [];
    if (stores.length) {
      parts.push(`Pickup ${stores[0].storeName} ${stores[0].distance}${stores.length > 1 ? ` +${stores.length - 1}` : ''}`);
    }
    if (courier?.courierAvailable) parts.push('2-hr courier');
    const hit = parts.length > 0;
    if (!hit) {
      const quote = shortPickupQuote(pickup.find((s) => s.partNumber === p.partNumber)?.quote);
      if (quote) parts.push(quote);
      if (courier?.shipText) parts.push(courier.shipText);
      if (parts.length === 0) parts.push('Unavailable');
    }
    return { partNumber: p.partNumber, name: p.name, status: parts.join(' · '), hit };
  });
}

// Link straight to the model's page (colour and storage already chosen), preferring the unlocked version.
export function modelUrl(html, productUrl, partNumber) {
  const products = (html && productSelectionData(html)?.products) || [];
  const tokens = products.filter((p) => p.partNumber === partNumber && p.seoUrlToken).map((p) => p.seoUrlToken);
  const token = tokens.find((t) => t.endsWith('-unlocked')) ?? tokens[0];
  return token ? `${productUrl}/${token}` : productUrl;
}

const MAX_LINES = 15;

export function buildMessage(items, names, url) {
  const lines = items.slice(0, MAX_LINES).map((item) => {
    const name = names.get(item.partNumber) ?? item.title ?? item.partNumber;
    if ('storeNumber' in item) return `Pickup: ${name} at ${item.storeName} (${item.distance}) - ${item.quote}`;
    return `2-hr courier: ${name} - ${item.courierText || 'available'}`;
  });
  const first = items[0];
  const firstName = names.get(first.partNumber) ?? first.partNumber;
  const where = 'storeNumber' in first ? `pickup at ${first.storeName}` : '2-hr courier';
  const more = items.length > 1 ? ` (+${items.length - 1} more)` : '';
  if (items.length > MAX_LINES) lines.push(`…and ${items.length - MAX_LINES} more`);
  return { subject: `In stock: ${firstName}, ${where}${more}`, text: lines.join('\n'), url };
}

function pick(obj) {
  const out = Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => SETTING_KEYS.includes(k)));
  if (!out.filters && (obj?.colors || obj?.capacities)) {
    out.filters = normalizeFilters({ dimensionColor: obj.colors, dimensionCapacity: obj.capacities });
  }
  return out;
}
