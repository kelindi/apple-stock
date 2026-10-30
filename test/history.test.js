import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateHistory } from '../src/history.js';
import { modelUrl } from '../src/checker.js';

const names = new Map([['MK274VC/A', 'iPhone Duo 512GB Night Sky']]);
const item = { partNumber: 'MK274VC/A', storeNumber: 'R121', storeName: 'Yorkdale', distance: '12 km', quote: 'Available Today' };
const seen = new Map([['pickup:R121:MK274VC/A', item]]);
const checked = new Set(['MK274VC/A']);

test('updateHistory opens an entry, extends it, then closes it when it sells out', () => {
  let h = updateHistory([], seen, { checked, names, now: 't1' });
  h = updateHistory(h, seen, { checked, names, now: 't2' });
  assert.equal(h.length, 1);
  assert.deepEqual(
    [h[0].name, h[0].storeName, h[0].firstSeen, h[0].lastSeen, h[0].endedAt],
    ['iPhone Duo 512GB Night Sky', 'Yorkdale', 't1', 't2', null],
  );
  h = updateHistory(h, new Map(), { checked, names, now: 't3' });
  assert.equal(h[0].endedAt, 't3');
  h = updateHistory(h, seen, { checked, names, now: 't4' });
  assert.equal(h.length, 2);
  assert.equal(h[1].endedAt, null);
});

test('updateHistory leaves entries open for models that were not checked', () => {
  const h = updateHistory(updateHistory([], seen, { checked, names, now: 't1' }), new Map(), { checked: new Set(), names, now: 't2' });
  assert.equal(h[0].endedAt, null);
});

test('modelUrl links to the unlocked model page', () => {
  const products = [
    { partNumber: 'MK274VC/A', seoUrlToken: '7.6-inch-display-512gb-night-sky-att' },
    { partNumber: 'MK274VC/A', seoUrlToken: '7.6-inch-display-512gb-night-sky-unlocked' },
  ];
  const html = `PRODUCT_SELECTION_BOOTSTRAP = { productSelectionData: ${JSON.stringify({ products })} }`;
  const base = 'https://www.apple.com/shop/buy-iphone/iphone-duo';
  assert.equal(modelUrl(html, base, 'MK274VC/A'), `${base}/7.6-inch-display-512gb-night-sky-unlocked`);
  assert.equal(modelUrl(html, base, 'OTHER'), base);
  assert.equal(modelUrl(null, base, 'MK274VC/A'), base);
});
