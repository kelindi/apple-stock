import { readFile, writeFile } from 'node:fs/promises';

const MAX_ENTRIES = 500;

export async function loadHistory(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// One entry per stretch of availability: opened when an item shows up, closed when a later
// check of the same model no longer finds it. Models that weren't checked stay open.
export function updateHistory(entries, current, { checked, names, now }) {
  const open = new Map(entries.filter((e) => !e.endedAt).map((e) => [e.key, e]));
  for (const [key, item] of current) {
    const entry = open.get(key);
    if (entry) {
      entry.lastSeen = now;
      continue;
    }
    const pickup = key.startsWith('pickup:');
    entries.push({
      key,
      type: pickup ? 'pickup' : 'courier',
      partNumber: item.partNumber,
      name: names.get(item.partNumber) ?? item.title ?? item.partNumber,
      storeName: pickup ? item.storeName : null,
      distance: pickup ? item.distance : null,
      quote: pickup ? item.quote : item.courierText,
      firstSeen: now,
      lastSeen: now,
      endedAt: null,
    });
  }
  for (const [key, entry] of open) if (!current.has(key) && checked.has(entry.partNumber)) entry.endedAt = now;
  return entries.slice(-MAX_ENTRIES);
}

export async function saveHistory(file, entries) {
  await writeFile(file, JSON.stringify({ entries }, null, 2) + '\n');
}
