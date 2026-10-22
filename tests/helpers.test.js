'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const helpers = require(path.join(__dirname, '..', 'assets', 'batch-apply.js'));

const BASE = 'http://shop.test/categoria-producto/deportes/varios/balonmano/';

const CONFIG = {
  separator: ';',
  fields: [
    { eName: '_price', entity: 'post_meta_num', view: 'range', params: ['min_filtro_precio', 'max_filtro_precio'] },
    { eName: 'pa_colores', entity: 'taxonomy', view: 'checkboxes', params: ['filtro_color'] },
    { eName: 'pa_talla', entity: 'taxonomy', view: 'checkboxes', params: ['filtro_talla'] },
    { eName: 'product_brand', entity: 'taxonomy', view: 'labels', params: ['filtro_marca'] },
    { eName: 'product_cat', entity: 'taxonomy', view: 'checkboxes', params: ['filtro_categoria'] },
  ],
};

/**
 * Reference copy of the 0.1.4 Apply URL algorithm with its hardcoded map.
 * The generic builder must produce byte-identical URLs for this shop.
 */
function legacyApplyUrl(href, selections, price) {
  const FIELDS = ['filtro_color', 'filtro_talla', 'filtro_marca', 'filtro_categoria'];
  const url = new URL(href);
  for (const key of FIELDS) url.searchParams.delete(key);
  if (price && price.changed) {
    url.searchParams.delete('min_filtro_precio');
    url.searchParams.delete('max_filtro_precio');
  }
  url.searchParams.delete('paged');
  url.searchParams.delete('product-page');
  url.pathname = url.pathname.replace(/\/page\/\d+\/?$/, '/');
  for (const key of FIELDS) {
    const selected = selections[key] || [];
    if (selected.length) url.searchParams.set(key, selected.join(';'));
  }
  if (price && price.changed && !price.reset) {
    url.searchParams.set('min_filtro_precio', String(price.min));
    url.searchParams.set('max_filtro_precio', String(price.max));
  }
  return url.href;
}

function multiFrom(selections) {
  return ['filtro_color', 'filtro_talla', 'filtro_marca', 'filtro_categoria']
    .map(param => ({ param, values: selections[param] || [] }));
}

test('parseValues splits on the separator and drops empty values', () => {
  assert.deepEqual(helpers.parseValues('rojo;azul;;verde', ';'), ['rojo', 'azul', 'verde']);
  assert.deepEqual(helpers.parseValues('', ';'), []);
  assert.deepEqual(helpers.parseValues(null, ';'), []);
  assert.deepEqual(helpers.parseValues('a,b', ','), ['a', 'b']);
});

test('readSelection reads one multi-value param from a URL', () => {
  const selection = helpers.readSelection(`${BASE}?filtro_color=rojo%3Bazul&orderby=price`, 'filtro_color', ';');
  assert.ok(selection instanceof Set);
  assert.deepEqual([...selection], ['rojo', 'azul']);
  assert.equal(helpers.readSelection(BASE, 'filtro_color', ';').size, 0);
});

test('buildFieldMap keys supported fields by eName and classifies them', () => {
  const map = helpers.buildFieldMap(CONFIG);
  assert.equal(map.size, 5);
  assert.equal(map.get('pa_colores').kind, 'multi');
  assert.deepEqual(map.get('pa_colores').params, ['filtro_color']);
  assert.equal(map.get('product_brand').kind, 'multi');
  assert.equal(map.get('_price').kind, 'range');
  assert.deepEqual(map.get('_price').params, ['min_filtro_precio', 'max_filtro_precio']);
});

test('buildFieldMap ignores malformed entries and missing config', () => {
  assert.equal(helpers.buildFieldMap(undefined).size, 0);
  assert.equal(helpers.buildFieldMap({}).size, 0);
  const map = helpers.buildFieldMap({
    fields: [
      null,
      { eName: '', params: ['x'] },
      { eName: 'no_params', view: 'checkboxes' },
      { eName: 'bad_range', entity: 'post_meta_num', view: 'range', params: ['min_x'] },
      { eName: 'ok', view: 'checkboxes', params: ['ok_param'] },
      { eName: 'ok', view: 'checkboxes', params: ['duplicate'] },
    ],
  });
  assert.deepEqual([...map.keys()], ['ok']);
  assert.deepEqual(map.get('ok').params, ['ok_param']);
});

test('deriveParamFromLink finds the param a checkbox link toggles', () => {
  // Adding a term to an empty field.
  assert.equal(
    helpers.deriveParamFromLink(`${BASE}?filtro_color=amarillo`, BASE, 'amarillo', ';'),
    'filtro_color'
  );
  // Adding a term while other filters are applied.
  assert.equal(
    helpers.deriveParamFromLink(
      `${BASE}?filtro_talla=m&filtro_color=rojo%3Bamarillo`,
      `${BASE}?filtro_talla=m&filtro_color=rojo`,
      'amarillo', ';'
    ),
    'filtro_color'
  );
  // Removing an applied term (checked checkbox).
  assert.equal(
    helpers.deriveParamFromLink(`${BASE}?filtro_talla=m`, `${BASE}?filtro_talla=m&filtro_color=rojo`, 'rojo', ';'),
    'filtro_color'
  );
  // Unrelated differences (pagination) do not confuse the match.
  assert.equal(
    helpers.deriveParamFromLink(`${BASE}?filtro_marca=kempa`, `${BASE}?paged=2`, 'kempa', ';'),
    'filtro_marca'
  );
});

test('deriveParamFromLink returns null when nothing matches', () => {
  assert.equal(helpers.deriveParamFromLink('', BASE, 'rojo', ';'), null);
  assert.equal(helpers.deriveParamFromLink('not a url', BASE, 'rojo', ';'), null);
  assert.equal(helpers.deriveParamFromLink(`${BASE}?orderby=price`, BASE, 'rojo', ';'), null);
});

test('computeBounds widens to whole numbers like 0.1.4', () => {
  assert.deepEqual(helpers.computeBounds('9.5', '120.2', '', ''), { lowerBound: 9, upperBound: 121 });
  assert.deepEqual(helpers.computeBounds(undefined, undefined, '5', '40'), { lowerBound: 5, upperBound: 40 });
  assert.deepEqual(helpers.computeBounds('10', '10', '', ''), { lowerBound: 10, upperBound: 11 });
  assert.deepEqual(helpers.computeBounds('', '', '', ''), { lowerBound: 0, upperBound: 1 });
});

test('clampRange rounds, clamps and keeps min <= max', () => {
  assert.deepEqual(helpers.clampRange(4.6, 200, 0, 100), { min: 5, max: 100 });
  assert.deepEqual(helpers.clampRange(-10, 50, 0, 100), { min: 0, max: 50 });
  assert.deepEqual(helpers.clampRange(80, 20, 0, 100), { min: 80, max: 80 });
});

test('initialRange reads applied bounds from the URL', () => {
  const params = ['min_filtro_precio', 'max_filtro_precio'];
  assert.deepEqual(helpers.initialRange(`${BASE}?min_filtro_precio=20&max_filtro_precio=60`, params, 0, 100), { min: 20, max: 60 });
  assert.deepEqual(helpers.initialRange(BASE, params, 0, 100), { min: 0, max: 100 });
  assert.deepEqual(helpers.initialRange(`${BASE}?min_filtro_precio=abc`, params, 0, 100), { min: 0, max: 100 });
});

test('rangeAction keeps untouched ranges and clears reset ones', () => {
  const base = { lowerBound: 0, upperBound: 100, min: 10, max: 90 };
  assert.equal(helpers.rangeAction({ ...base, changed: false, reset: false }, false), 'keep');
  assert.equal(helpers.rangeAction({ ...base, changed: true, reset: true }, true), 'clear');
  assert.equal(helpers.rangeAction({ ...base, changed: true, reset: false }, false), 'set');
});

test('buildApplyUrl matches the 0.1.4 URL format for this shop', () => {
  const cases = [
    {
      href: `${BASE}page/3/?orderby=price&filtro_color=rojo&min_filtro_precio=10&max_filtro_precio=50&paged=3`,
      selections: { filtro_color: ['rojo', 'azul'], filtro_talla: ['m'] },
      price: { changed: false, reset: false, min: 10, max: 50 },
    },
    {
      href: `${BASE}?product-page=2&filtro_categoria=balonmano`,
      selections: { filtro_categoria: ['balonmano'], filtro_marca: ['kempa', 'hummel'] },
      price: { changed: true, reset: false, min: 15, max: 80 },
    },
    {
      href: `${BASE}?min_filtro_precio=10&max_filtro_precio=50&q=a+b`,
      selections: {},
      price: { changed: true, reset: true, min: 0, max: 100 },
    },
    {
      href: BASE,
      selections: { filtro_color: ['amarillo-claro'] },
      price: null,
    },
  ];
  for (const { href, selections, price } of cases) {
    const ranges = price ? [{
      params: ['min_filtro_precio', 'max_filtro_precio'],
      action: helpers.rangeAction({ ...price, lowerBound: 0, upperBound: 100 }, true),
      min: price.min,
      max: price.max,
    }] : [];
    const actual = helpers.buildApplyUrl(href, { multi: multiFrom(selections), ranges, separator: ';' });
    assert.equal(actual, legacyApplyUrl(href, selections, price));
  }
});

test('buildApplyUrl appends multi params before range params', () => {
  const actual = helpers.buildApplyUrl(`${BASE}?orderby=price`, {
    multi: [{ param: 'filtro_color', values: new Set(['rojo']) }],
    ranges: [{ params: ['min_peso', 'max_peso'], action: 'set', min: 1, max: 3 }],
    separator: ';',
  });
  assert.equal(actual, `${BASE}?orderby=price&filtro_color=rojo&min_peso=1&max_peso=3`);
});

test('buildResetUrl removes managed params and pagination only', () => {
  const href = `${BASE}page/2/?orderby=price&filtro_color=rojo&min_filtro_precio=1&max_filtro_precio=9&paged=2&product-page=2`;
  const actual = helpers.buildResetUrl(href, ['filtro_color', 'filtro_talla', 'min_filtro_precio', 'max_filtro_precio']);
  assert.equal(actual, `${BASE}?orderby=price`);
  assert.equal(helpers.buildResetUrl(BASE, ['filtro_color']), BASE);
});

test('rangeLabels appends the currency symbol to price labels only', () => {
  const strings = { from: 'Desde', to: 'Hasta', minPrice: 'Precio mínimo', maxPrice: 'Precio máximo', minValue: 'Mínimo', maxValue: 'Máximo' };
  assert.deepEqual(helpers.rangeLabels(strings, '€', true), {
    from: 'Desde (€)', to: 'Hasta (€)', min: 'Precio mínimo', max: 'Precio máximo',
  });
  assert.deepEqual(helpers.rangeLabels(strings, '€', false), {
    from: 'Desde', to: 'Hasta', min: 'Mínimo', max: 'Máximo',
  });
  assert.deepEqual(helpers.rangeLabels(strings, '', true), {
    from: 'Desde', to: 'Hasta', min: 'Precio mínimo', max: 'Precio máximo',
  });
});

test('rangeAction omits an untouched full range when no range is applied', () => {
  const full = { lowerBound: 0, upperBound: 100, min: 0, max: 100, changed: true, reset: false };
  assert.equal(helpers.rangeAction(full, false), 'clear');
  // An applied range moved back to the full bounds is still written.
  assert.equal(helpers.rangeAction(full, true), 'set');
  assert.equal(helpers.rangeAction({ ...full, min: 1 }, false), 'set');
});

test('buildApplyUrl adds no range params for a full untouched range', () => {
  const state = { lowerBound: 0, upperBound: 100, min: 0, max: 100, changed: true, reset: false };
  const actual = helpers.buildApplyUrl(`${BASE}?orderby=price`, {
    multi: [{ param: 'filtro_color', values: ['rojo'] }],
    ranges: [{ params: ['min_filtro_precio', 'max_filtro_precio'], action: helpers.rangeAction(state, false), min: 0, max: 100 }],
    separator: ';',
  });
  assert.equal(actual, `${BASE}?orderby=price&filtro_color=rojo`);
});

test('isRangeApplied detects either bound in the URL', () => {
  const params = ['min_filtro_precio', 'max_filtro_precio'];
  assert.equal(helpers.isRangeApplied(`${BASE}?max_filtro_precio=40`, params), true);
  assert.equal(helpers.isRangeApplied(`${BASE}?min_filtro_precio=4`, params), true);
  assert.equal(helpers.isRangeApplied(`${BASE}?orderby=price`, params), false);
});

/** Manual clock for timer-based helpers. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const queue = new Map();
  return {
    setTimeout(fn, delay) { const id = nextId++; queue.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { queue.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...queue]) {
        if (timer.at <= now) { queue.delete(id); timer.fn(); }
      }
    },
    get size() { return queue.size; },
  };
}

test('NAVIGATION_TIMEOUT_MS allows a slow 20 s server response', () => {
  assert.equal(helpers.NAVIGATION_TIMEOUT_MS, 30000);
});

test('createNavigationGuard releases the busy state when navigation never commits', () => {
  const timers = fakeTimers();
  let released = 0;
  const guard = helpers.createNavigationGuard(() => { released++; }, { timers });
  guard.start();
  assert.equal(guard.pending, true);
  timers.advance(helpers.NAVIGATION_TIMEOUT_MS - 1);
  assert.equal(released, 0);
  timers.advance(1);
  assert.equal(released, 1);
  assert.equal(guard.pending, false);
});

test('createNavigationGuard cancel and restart keep a single timer', () => {
  const timers = fakeTimers();
  let released = 0;
  const guard = helpers.createNavigationGuard(() => { released++; }, { timers, timeout: 100 });
  guard.start();
  timers.advance(60);
  guard.start();
  assert.equal(timers.size, 1);
  timers.advance(60);
  assert.equal(released, 0);
  guard.cancel();
  assert.equal(guard.pending, false);
  timers.advance(1000);
  assert.equal(released, 0);
  guard.cancel();
});

/** Minimal element stub: `matches`/`querySelector` answer from class lists. */
function fakeElement(classes, descendants = []) {
  const has = (list, selector) => selector.split(',').some(part => list.includes(part.trim().replace(/^\./, '')));
  return {
    nodeType: 1,
    matches: selector => has(classes, selector),
    querySelector: selector => descendants.some(list => has(list, selector)) ? {} : null,
  };
}

test('mutationsAddWidget finds added widgets or ancestors that contain one', () => {
  const selector = '.wpc-filters-main-wrap, .wpc-filters-widget-wrapper';
  const text = { nodeType: 3 };
  const widget = fakeElement(['wpc-filters-main-wrap']);
  const sidebar = fakeElement(['widget-area'], [['widget'], ['wpc-filters-widget-wrapper']]);
  const product = fakeElement(['product'], [['price']]);
  assert.equal(helpers.mutationsAddWidget([{ addedNodes: [text, widget] }], selector), true);
  assert.equal(helpers.mutationsAddWidget([{ addedNodes: [] }, { addedNodes: [sidebar] }], selector), true);
  assert.equal(helpers.mutationsAddWidget([{ addedNodes: [text, product] }], selector), false);
  assert.equal(helpers.mutationsAddWidget([{ addedNodes: [], removedNodes: [widget] }], selector), false);
  assert.equal(helpers.mutationsAddWidget([], selector), false);
});

/** Two filter sets on one page sharing an e_name with different slugs. */
const TWO_SETS = {
  separator: ';',
  fields: [
    { eName: 'pa_colores', entity: 'taxonomy', view: 'checkboxes', params: ['color'], setId: 10 },
    { eName: '_price', entity: 'post_meta_num', view: 'range', params: ['min_price', 'max_price'], setId: 10 },
    { eName: 'pa_colores', entity: 'taxonomy', view: 'labels', params: ['colour'], setId: 20 },
    { eName: '_price', entity: 'post_meta_num', view: 'range', params: ['min_cost', 'max_cost'], setId: 20 },
  ],
};

test('buildFieldMap resolves each root to the params of its own filter set', () => {
  const first = helpers.buildFieldMap(TWO_SETS, '10');
  assert.deepEqual(first.get('pa_colores').params, ['color']);
  assert.deepEqual(first.get('_price').params, ['min_price', 'max_price']);
  const second = helpers.buildFieldMap(TWO_SETS, '20');
  assert.deepEqual(second.get('pa_colores').params, ['colour']);
  assert.equal(second.get('pa_colores').view, 'labels');
  assert.deepEqual(second.get('_price').params, ['min_cost', 'max_cost']);
  // Numeric and string set IDs are equivalent.
  assert.deepEqual(helpers.buildFieldMap(TWO_SETS, 20).get('pa_colores').params, ['colour']);
});

test('buildFieldMap falls back to e_name-only matching without set information', () => {
  // Root without a set ID: first field per e_name wins (0.2.0 behavior).
  assert.deepEqual(helpers.buildFieldMap(TWO_SETS).get('pa_colores').params, ['color']);
  assert.deepEqual(helpers.buildFieldMap(TWO_SETS, '').get('pa_colores').params, ['color']);
  // Root whose set has no configured field: same legacy map.
  assert.deepEqual(helpers.buildFieldMap(TWO_SETS, '99').get('pa_colores').params, ['color']);
  // Fields without a set ID are shared by every root.
  const legacy = helpers.buildFieldMap(CONFIG, '4606');
  assert.equal(legacy.size, 5);
  assert.deepEqual(legacy.get('pa_colores').params, ['filtro_color']);
  // A field of the root's own set wins over a set-less one with the same e_name.
  const mixed = helpers.buildFieldMap({
    fields: [
      { eName: 'pa_talla', view: 'checkboxes', params: ['size'] },
      { eName: 'pa_talla', view: 'checkboxes', params: ['talla'], setId: 7 },
      { eName: 'pa_talla', view: 'checkboxes', params: ['other'], setId: 8 },
    ],
  }, '7');
  assert.deepEqual(mixed.get('pa_talla').params, ['talla']);
});

test('rootSetId reads data-set, then the wpc-filter-set-N class', () => {
  assert.equal(helpers.rootSetId('4606', 'wpc-filters-main-wrap wpc-filter-set-1'), '4606');
  assert.equal(helpers.rootSetId('', 'wpc-filters-main-wrap  wpc-filter-set-4606'), '4606');
  assert.equal(helpers.rootSetId(undefined, 'wpc-filter-set-12 other'), '12');
  assert.equal(helpers.rootSetId('abc', 'wpc-filter-set-widget-title'), '');
  assert.equal(helpers.rootSetId(undefined, ''), '');
});

test('snapshotState copies selections and range states as rendered', () => {
  const selections = new Map([['filtro_color', new Set(['rojo'])], ['filtro_talla', new Set()]]);
  const ranges = [{ params: ['min_p', 'max_p'], min: 20, max: 60, changed: false, reset: false, lowerBound: 10, upperBound: 96 }];
  const snapshot = helpers.snapshotState(selections, ranges);
  // Later changes do not leak into the snapshot.
  selections.get('filtro_color').add('azul');
  selections.get('filtro_talla').add('xl');
  Object.assign(ranges[0], { min: 30, max: 40, changed: true, reset: true });
  assert.deepEqual([...snapshot.selections.get('filtro_color')], ['rojo']);
  assert.deepEqual([...snapshot.selections.get('filtro_talla')], []);
  assert.deepEqual(snapshot.ranges, [{ min: 20, max: 60, changed: false, reset: false }]);
});

test('restoreState puts selections and ranges back in place', () => {
  const selections = new Map([['filtro_color', new Set(['rojo'])], ['filtro_talla', new Set()]]);
  const colorSet = selections.get('filtro_color');
  const ranges = [{ params: ['min_p', 'max_p'], min: 10, max: 96, changed: false, reset: false, lowerBound: 10, upperBound: 96 }];
  const snapshot = helpers.snapshotState(selections, ranges);
  colorSet.delete('rojo');
  colorSet.add('azul');
  selections.get('filtro_talla').add('xl');
  Object.assign(ranges[0], { min: 25, max: 70, changed: true });
  helpers.restoreState(snapshot, selections, ranges);
  // Same Set objects (other closures hold them), back to the snapshot.
  assert.equal(selections.get('filtro_color'), colorSet);
  assert.deepEqual([...colorSet], ['rojo']);
  assert.deepEqual([...selections.get('filtro_talla')], []);
  assert.deepEqual({ min: ranges[0].min, max: ranges[0].max, changed: ranges[0].changed, reset: ranges[0].reset },
    { min: 10, max: 96, changed: false, reset: false });
  // Range fields outside the snapshot are untouched.
  assert.deepEqual(ranges[0].params, ['min_p', 'max_p']);
  assert.equal(ranges[0].upperBound, 96);
});

test('revealDelta scrolls a control out from under a sticky box at the bottom', () => {
  const box = { top: 800, bottom: 880, left: 12, right: 308 };
  // Control partly under the box: scroll down until it sits 12px above it.
  assert.equal(helpers.revealDelta({ top: 790, bottom: 810, left: 20, right: 40 }, box, 12), 22);
  // Fully under the box.
  assert.equal(helpers.revealDelta({ top: 820, bottom: 840, left: 20, right: 40 }, box, 12), 52);
});

test('revealDelta scrolls up when the box sits above the control', () => {
  const box = { top: 0, bottom: 80, left: 12, right: 308 };
  assert.equal(helpers.revealDelta({ top: 70, bottom: 90, left: 20, right: 40 }, box, 12), -22);
});

test('revealDelta is 0 when the control and the box do not overlap', () => {
  const box = { top: 800, bottom: 880, left: 12, right: 308 };
  // Above, touching, below (off screen, as after a focus without scrolling), beside.
  assert.equal(helpers.revealDelta({ top: 700, bottom: 720, left: 20, right: 40 }, box, 12), 0);
  assert.equal(helpers.revealDelta({ top: 780, bottom: 800, left: 20, right: 40 }, box, 12), 0);
  assert.equal(helpers.revealDelta({ top: 2600, bottom: 2620, left: 20, right: 40 }, box, 12), 0);
  assert.equal(helpers.revealDelta({ top: 820, bottom: 840, left: 320, right: 340 }, box, 12), 0);
  // An empty box (hidden) never overlaps.
  assert.equal(helpers.revealDelta({ top: 820, bottom: 840, left: 20, right: 40 }, { top: 0, bottom: 0, left: 0, right: 0 }, 12), 0);
});

test('isTermToggleKey accepts plain Space and Enter only', () => {
  const key = (k, mods = {}) => Object.assign({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, mods);
  assert.equal(helpers.isTermToggleKey(key(' ')), true);
  assert.equal(helpers.isTermToggleKey(key('Enter')), true);
  assert.equal(helpers.isTermToggleKey(key('Tab')), false);
  assert.equal(helpers.isTermToggleKey(key('a')), false);
  // Modified keys are left to the browser (shortcuts, assistive tech).
  for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(helpers.isTermToggleKey(key(' ', { [modifier]: true })), false, `Space + ${modifier}`);
    assert.equal(helpers.isTermToggleKey(key('Enter', { [modifier]: true })), false, `Enter + ${modifier}`);
  }
});
