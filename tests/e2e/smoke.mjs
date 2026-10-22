#!/usr/bin/env node
/**
 * Browser smoke tests for Filter Everything Batch Apply.
 *
 * Drives a local Chrome or Edge over the DevTools protocol (Node 24 built-in
 * fetch and WebSocket, no npm dependencies) against a running WordPress site
 * with Filter Everything and this add-on active.
 *
 *   node tests/e2e/smoke.mjs
 *
 * Environment:
 *   BASE_URL        Site root (default http://localhost:8080).
 *   ARCHIVE_PATH    Page that renders a filter widget (default /shop/).
 *   NO_WIDGET_PATH  Page without a widget (default /?s=camiseta&post_type=product).
 *   CHROME_PATH     Chrome/Edge executable; otherwise common paths are tried.
 *   CDP_URL         Attach to a browser already started with
 *                   --remote-debugging-port (e.g. http://127.0.0.1:9222)
 *                   instead of launching one.
 *
 * Back is run twice: in the main browser (usually restored from the
 * back/forward cache) and in a second browser launched with
 * --disable-features=BackForwardCache, where Back reloads the page and the
 * browser restores form control state, as for logged-in visitors who get
 * `Cache-Control: no-store`. With CDP_URL only the attached browser runs.
 *
 * Exit code 0 when every scenario passes or when no browser is found
 * (prints SKIPPED); 1 when a scenario fails or the site is unreachable.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const ARCHIVE_PATH = process.env.ARCHIVE_PATH || '/shop/';
const NO_WIDGET_PATH = process.env.NO_WIDGET_PATH || '/?s=camiseta&post_type=product';
const TIMEOUT_MS = 30000;
const VIEWPORT = { width: 1440, height: 900 };
const PAGINATION_PARAMS = ['paged', 'product-page'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CheckFailure extends Error {}

function check(condition, message) {
  if (!condition) throw new CheckFailure(message);
}

/* ------------------------------------------------------------------
 * Browser discovery, launch and attach.
 * ------------------------------------------------------------------ */

function findBrowser() {
  if (process.env.CHROME_PATH) {
    return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  }
  const env = process.env;
  const candidates = [
    env.ProgramFiles && join(env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
  return candidates.find(path => path && existsSync(path)) || null;
}

/** Starts a headless browser with a throwaway profile; resolves its HTTP endpoint. */
async function launchBrowser(executable, extraArgs = []) {
  const profile = mkdtempSync(join(tmpdir(), 'fe-batch-smoke-'));
  const child = spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...extraArgs, 'about:blank',
  ], { stdio: 'ignore' });
  const close = async () => {
    child.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch (error) { /* profile still locked */ }
  };
  // The browser writes its chosen port to DevToolsActivePort.
  const portFile = join(profile, 'DevToolsActivePort');
  for (let waited = 0; waited < TIMEOUT_MS; waited += 100) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (port) return { endpoint: `http://127.0.0.1:${port}`, close };
    }
    await sleep(100);
  }
  await close();
  throw new Error(`${executable} did not open a DevTools port`);
}

/** Opens a new tab and resolves its WebSocket URL plus a cleanup function. */
async function openTab(endpoint) {
  const response = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) throw new Error(`Cannot open a tab at ${endpoint} (HTTP ${response.status})`);
  const target = await response.json();
  return {
    wsUrl: target.webSocketDebuggerUrl,
    close: () => fetch(`${endpoint}/json/close/${target.id}`).catch(() => {}),
  };
}

/* ------------------------------------------------------------------
 * DevTools protocol session.
 * ------------------------------------------------------------------ */

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`Cannot connect to ${wsUrl}`)), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DevTools timeout: ${method}`));
    }, TIMEOUT_MS);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const on = listener => listeners.add(listener);
  /** Resolves with the next event named `method` (optionally matching `predicate`). */
  const waitForEvent = (method, timeout = TIMEOUT_MS, predicate = () => true) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new CheckFailure(`Timed out waiting for ${method}`));
    }, timeout);
    const listener = message => {
      if (message.method !== method || !predicate(message.params)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(message.params);
    };
    listeners.add(listener);
  });
  return { send, on, waitForEvent, close: () => socket.close() };
}

/* ------------------------------------------------------------------
 * Page helpers.
 * ------------------------------------------------------------------ */

async function createPage(session) {
  const { send } = session;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
  const { frameTree } = await send('Page.getFrameTree');
  const mainFrameId = frameTree.frame.id;

  // Main-frame document requests (one per navigation attempt), page errors
  // and why the back/forward cache was not used for a history navigation.
  const documentRequests = [];
  const errors = [];
  const cacheNotUsed = [];
  session.on(({ method, params }) => {
    if (method === 'Network.requestWillBeSent' && params.type === 'Document' && params.frameId === mainFrameId) {
      documentRequests.push(params.request.url);
    } else if (method === 'Page.backForwardCacheNotUsed') {
      cacheNotUsed.push((params.notRestoredExplanations || []).map(item => item.reason).join(', ') || 'unknown');
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails;
      errors.push((details.exception && details.exception.description) || details.text);
    } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      errors.push(`console.error: ${params.args.map(arg => arg.value ?? arg.description).join(' ')}`);
    }
  });

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(`Page script failed: ${(details.exception && details.exception.description) || details.text}`);
    }
    return result.result.value;
  }

  /** Polls `expression` until it is truthy; returns its value. */
  async function waitUntil(expression, message, timeout = 5000) {
    for (let waited = 0; waited <= timeout; waited += 100) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(100);
    }
    throw new CheckFailure(message);
  }

  /** Runs `action` and resolves once the next page has loaded. */
  async function expectNavigation(action) {
    const loaded = session.waitForEvent('Page.loadEventFired');
    loaded.catch(() => {}); // Reported below; avoids an unhandled rejection if `action` throws.
    await action();
    await loaded;
  }

  async function goto(path, { widget = true } = {}) {
    await expectNavigation(() => send('Page.navigate', { url: BASE_URL + path }));
    if (widget) await waitUntil('!!document.querySelector(".fe-batch-ready .fe-batch-controls")', `No initialized widget on ${path}`);
  }

  /**
   * Clicks the element at `selector` with real mouse input when it is
   * visible and on top; otherwise (for example a closed off-canvas panel)
   * dispatches a DOM click. Returns the mode used.
   */
  async function click(selector) {
    const point = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, onTop: r.width > 0 && r.height > 0 && !!hit && (hit === el || el.contains(hit)) };
    })()`);
    check(point, `Element not found: ${selector}`);
    if (!point.onTop) {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
      return 'dom';
    }
    const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    return 'mouse';
  }

  /**
   * Presses Space, Enter or Tab on the focused element with real key input.
   * `modifiers` is the DevTools bit mask (1 Alt, 2 Ctrl, 4 Meta, 8 Shift);
   * `keyUp: false` sends only the key down.
   */
  async function press(key, { modifiers = 0, keyUp = true } = {}) {
    const keys = {
      Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    };
    const { text, ...definition } = keys[key];
    // Keys without text (Tab) are raw key downs, as with a real keyboard.
    await send('Input.dispatchKeyEvent', text ? { type: 'keyDown', ...definition, text, modifiers } : { type: 'rawKeyDown', ...definition, modifiers });
    if (keyUp) await send('Input.dispatchKeyEvent', { type: 'keyUp', ...definition, modifiers });
  }

  return { send, evaluate, waitUntil, expectNavigation, goto, click, press, documentRequests, errors, cacheNotUsed };
}

/* ------------------------------------------------------------------
 * Widget helpers (run inside the page).
 * ------------------------------------------------------------------ */

const ITEM_SELECTOR = 'li.wpc-checkbox-item, li.wpc-label-item';

/**
 * Marks `count` unchecked items of distinct fields in the first initialized
 * widget with data-smoke="0..n" (and its term link with data-smoke-target). With `wanted` ([{ eName, slug }]) marks
 * those exact terms instead. Returns [{ eName, slug }].
 */
async function markItems(page, count, wanted = null) {
  const items = await page.evaluate(`(() => {
    const wanted = ${JSON.stringify(wanted)};
    const root = document.querySelector('.fe-batch-ready');
    const picked = [];
    const fields = new Set();
    for (const li of root.querySelectorAll(${JSON.stringify(ITEM_SELECTOR)})) {
      const input = li.querySelector('input[type="checkbox"][data-wpc-e-name][data-wpc-slug]');
      if (!input) continue;
      const item = { eName: input.dataset.wpcEName, slug: input.dataset.wpcSlug };
      const match = wanted
        ? wanted.some(w => w.eName === item.eName && w.slug === item.slug)
        : !input.checked && !fields.has(item.eName) && picked.length < ${count};
      if (!match) continue;
      li.dataset.smoke = String(picked.length);
      // What a shopper clicks: the term link inside the label.
      (li.querySelector('label a') || li.querySelector('label') || li).dataset.smokeTarget = String(picked.length);
      fields.add(item.eName);
      picked.push(item);
    }
    return picked;
  })()`);
  check(items.length === (wanted ? wanted.length : count), `Expected ${wanted ? wanted.length : count} filter items, found ${items.length}`);
  return items;
}

const itemSelector = index => `li[data-smoke="${index}"]`;
const clickTarget = index => `[data-smoke-target="${index}"]`;

/** Checked state of a marked item, after the add-on's deferred sync. */
async function itemState(page, index) {
  await sleep(150);
  return page.evaluate(`(() => {
    const li = document.querySelector('${itemSelector(index)}');
    const input = li.querySelector('input[type="checkbox"]');
    return { checked: input.checked, selected: li.classList.contains('wpc-term-selected') };
  })()`);
}

async function expectChecked(page, index, expected, step) {
  const state = await itemState(page, index);
  check(state.checked === expected && state.selected === expected,
    `${step}: expected checked=${expected}, got checked=${state.checked} selected=${state.selected}`);
}

/** URL param of a field from the page's config (the root's set first). */
async function paramFor(page, eName) {
  return page.evaluate(`(() => {
    const config = window.feBatchApplyConfig;
    const set = document.querySelector('.fe-batch-ready').dataset.set;
    const fields = (config && config.fields || []).filter(f => f.eName === ${JSON.stringify(eName)});
    const field = fields.find(f => String(f.setId) === set) || fields[0];
    return field ? field.params[0] : null;
  })()`);
}

/* ------------------------------------------------------------------
 * Scenarios. Each returns a short detail string or throws.
 * ------------------------------------------------------------------ */

const state = { applyStart: null, applyItems: null, applyResult: null };

async function clicksToggleLocally(page) {
  await page.goto(ARCHIVE_PATH);
  await markItems(page, 2);
  const requests = page.documentRequests.length;
  const modes = new Set();
  for (const [index, expected] of [[0, true], [0, false], [0, true], [1, true]]) {
    modes.add(await page.click(clickTarget(index)));
    await expectChecked(page, index, expected, `click ${index}`);
  }
  check(page.documentRequests.length === requests, `Clicks sent ${page.documentRequests.length - requests} document request(s)`);
  return `4 clicks toggled once each, no navigation (${[...modes].join('/')} clicks)`;
}

async function keyboardTogglesOnce(page) {
  await page.goto(ARCHIVE_PATH);
  await markItems(page, 1);
  const focused = await page.evaluate(`(() => {
    const input = document.querySelector('${itemSelector(0)} input[type="checkbox"]');
    input.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    return document.activeElement === input;
  })()`);
  check(focused, 'Checkbox cannot be focused');
  const requests = page.documentRequests.length;
  for (const [key, expected] of [['Space', true], ['Space', false], ['Enter', true], ['Enter', false]]) {
    await page.press(key);
    await expectChecked(page, 0, expected, key);
    check(await page.evaluate('window.scrollY') === 0, `${key} scrolled the page`);
  }
  check(page.documentRequests.length === requests, 'A key press navigated');

  // Enter with Alt, Ctrl, Meta or Shift is left to the browser: it reaches
  // window listeners with its default intact and toggles nothing.
  await page.evaluate(`(() => {
    window.__smokeKeys = [];
    addEventListener('keydown', event => { window.__smokeKeys.push(event.defaultPrevented); });
  })()`);
  for (const [name, modifiers] of [['Alt', 1], ['Ctrl', 2], ['Meta', 4], ['Shift', 8]]) {
    await page.press('Enter', { modifiers });
    await expectChecked(page, 0, false, `${name}+Enter`);
  }
  const seen = await page.evaluate('window.__smokeKeys');
  check(seen.length === 4 && seen.every(prevented => !prevented), `Modified Enter was handled by the add-on: ${JSON.stringify(seen)}`);

  // A Space key-up that never arrives (focus moved away while the key was
  // down) must not swallow a later screen-reader click (detail 0).
  await page.evaluate(`document.querySelector('${itemSelector(0)} input[type="checkbox"]').focus()`);
  await page.press('Space', { keyUp: false });
  await expectChecked(page, 0, true, 'Space key-down');
  await page.press('Tab');
  await page.evaluate(`document.querySelector('${itemSelector(0)} input[type="checkbox"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))`);
  await expectChecked(page, 0, false, 'screen-reader click after a lost Space key-up');
  return 'Space, Space, Enter, Enter toggled once each, no scroll; modified Enter ignored; lost Space key-up cleared';
}

async function tabMovesBetweenCheckboxes(page) {
  await page.goto(ARCHIVE_PATH);
  // A displayed term followed by another displayed term of the same list.
  const found = await page.evaluate(`(() => {
    const INPUT = 'input[type="checkbox"][data-wpc-e-name][data-wpc-slug]';
    const shown = li => !!li && li.matches(${JSON.stringify(ITEM_SELECTOR)}) && !!li.querySelector(INPUT) && li.getClientRects().length > 0;
    const from = [...document.querySelectorAll('.fe-batch-ready li')].find(li => shown(li) && shown(li.nextElementSibling));
    if (!from) return false;
    from.dataset.smokeTab = 'from';
    from.nextElementSibling.dataset.smokeTab = 'to';
    const input = from.querySelector(INPUT);
    input.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    return document.activeElement === input;
  })()`);
  check(found, 'No two consecutive displayed terms, or the checkbox cannot be focused');
  await page.press('Tab');
  const landed = await page.evaluate(`(() => {
    const el = document.activeElement;
    return { onNext: el === document.querySelector('li[data-smoke-tab="to"] input[type="checkbox"]'), tag: el.tagName, className: String(el.className) };
  })()`);
  check(landed.onNext, `Tab landed on ${landed.tag}.${landed.className}, not the next term's checkbox`);
  const requests = page.documentRequests.length;
  await page.press('Space');
  await sleep(150);
  const after = await page.evaluate(`(() => {
    const li = document.querySelector('li[data-smoke-tab="to"]');
    return { checked: li.querySelector('input').checked, selected: li.classList.contains('wpc-term-selected'), scrollY: window.scrollY };
  })()`);
  check(after.checked && after.selected, `Space did not toggle the next term once: ${JSON.stringify(after)}`);
  check(after.scrollY === 0, `Space scrolled the page to ${after.scrollY}`);
  check(page.documentRequests.length === requests, 'Space navigated');
  return 'Tab reached the next term checkbox; Space toggled it once without scrolling';
}

/**
 * Tab through the terms from the first displayed one: the focused control
 * must never sit under the sticky Apply/Reset box. Reduced motion is
 * emulated so the add-on scrolls instantly.
 */
async function focusNeverUnderControls(page) {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    await page.goto(ARCHIVE_PATH);
    const started = await page.evaluate(`(() => {
      const root = document.querySelector('.fe-batch-ready');
      const input = [...root.querySelectorAll(${JSON.stringify(ITEM_SELECTOR)})]
        .map(li => li.querySelector('input[type="checkbox"]'))
        .find(el => el && el.closest('li').getClientRects().length > 0);
      if (!input) return false;
      input.focus();
      return document.activeElement === input;
    })()`);
    check(started, 'No displayed term checkbox to start from');
    // Rect of the focused control (the visible label in the Labels view)
    // and of its widget's controls box; null once focus leaves the terms.
    const PROBE = `(() => {
      const el = document.activeElement;
      const root = el && el.closest('.fe-batch-ready');
      if (!root || el.closest('.fe-batch-controls')) return null;
      const labelItem = el.closest('li.wpc-label-item');
      const r = ((labelItem && labelItem.querySelector('label')) || el).getBoundingClientRect();
      const b = root.querySelector('.fe-batch-controls').getBoundingClientRect();
      const overlap = r.bottom > b.top && r.top < b.bottom && r.right > b.left && r.left < b.right;
      return { overlap, name: el.tagName + (el.dataset.wpcSlug ? ':' + el.dataset.wpcSlug : ''), top: Math.round(r.top), bottom: Math.round(r.bottom), boxTop: Math.round(b.top) };
    })()`;
    let steps = 0;
    let nearBox = 0;
    for (; steps < 40; steps++) {
      const probe = await page.evaluate(PROBE);
      if (!probe) break;
      check(!probe.overlap, `Focused ${probe.name} (${probe.top}..${probe.bottom}) is under the controls box (top ${probe.boxTop}) after ${steps} Tab(s)`);
      if (probe.boxTop - probe.bottom < 40) nearBox++;
      await page.press('Tab');
      await sleep(150);
    }
    check(steps > 1, 'Tab left the terms immediately');
    return `${steps} focus stops checked, none under the box (${nearBox} right above it)`;
  } finally {
    await page.send('Emulation.setEmulatedMedia', { features: [] });
  }
}

async function applyNavigatesOnce(page) {
  const start = `${ARCHIVE_PATH}${ARCHIVE_PATH.includes('?') ? '&' : '?'}orderby=price&smoke=keep&paged=2`;
  await page.goto(start);
  const startHref = await page.evaluate('location.href');
  const items = await markItems(page, 2);
  for (const index of [0, 1]) await page.click(clickTarget(index));
  const params = await Promise.all(items.map(item => paramFor(page, item.eName)));
  check(params.every(Boolean), 'A picked field has no param in feBatchApplyConfig');
  // Fields already checked on load (e.g. the archive's own category) are written too.
  const checkedNames = await page.evaluate(`[...new Set([...document.querySelectorAll('.fe-batch-ready input[type="checkbox"][data-wpc-e-name]:checked')].map(i => i.dataset.wpcEName))]`);
  const checkedParams = await Promise.all(checkedNames.map(eName => paramFor(page, eName)));

  const requests = page.documentRequests.length;
  let busy;
  await page.expectNavigation(async () => {
    // Read the busy state synchronously after the click, then click again.
    // Chrome merges a repeated navigation to the same pending URL, so the
    // request count alone cannot reveal a double submission: the disabled
    // buttons are what prevent it, and they are asserted here.
    busy = await page.evaluate(`(() => {
      const apply = document.querySelector('.fe-batch-ready .fe-batch-apply');
      const reset = document.querySelector('.fe-batch-ready .fe-batch-reset');
      const label = apply.textContent;
      apply.click();
      const result = { applyDisabled: apply.disabled, resetDisabled: reset.disabled, ariaBusy: apply.getAttribute('aria-busy'), labelChanged: apply.textContent !== label };
      apply.click();
      return result;
    })()`);
  });
  await sleep(300);
  check(busy.applyDisabled && busy.resetDisabled && busy.ariaBusy === 'true' && busy.labelChanged,
    `Busy state not set: ${JSON.stringify(busy)}`);
  const sent = page.documentRequests.length - requests;
  check(sent === 1, `Apply sent ${sent} document requests`);

  const actual = new URL(await page.evaluate('location.href'));
  const before = new URL(startHref);
  check(!PAGINATION_PARAMS.some(param => actual.searchParams.has(param)) && !/\/page\/\d+\/?$/.test(actual.pathname),
    `Pagination not reset: ${actual.href}`);
  for (const [key, value] of before.searchParams) {
    if (!PAGINATION_PARAMS.includes(key) && !params.includes(key)) {
      check(actual.searchParams.get(key) === value, `Unrelated param ${key} not preserved: ${actual.href}`);
    }
  }
  const separator = await page.evaluate('(window.feBatchApplyConfig && window.feBatchApplyConfig.separator) || ";"');
  items.forEach((item, index) => {
    const values = (actual.searchParams.get(params[index]) || '').split(separator);
    check(values.includes(item.slug), `${params[index]} lacks ${item.slug}: ${actual.href}`);
  });
  const allowed = new Set([...before.searchParams.keys(), ...params, ...checkedParams]);
  const extra = [...actual.searchParams.keys()].filter(key => !allowed.has(key));
  check(extra.length === 0, `Unexpected params ${extra.join(', ')}: ${actual.href}`);

  Object.assign(state, { applyStart: start, applyItems: items, applyResult: actual.href });
  return `busy state set, 1 request: ${before.pathname}${before.search} -> ${actual.pathname}${actual.search}`;
}

/**
 * Check a term, Apply, then Back. Whether the browser brings the page back
 * from its back/forward cache (same document) or reloads it (form control
 * state restored by the browser), every checkbox must show the rendered
 * state and the local selection must match the URL again. `cache` is
 * "any" (report which path ran) or "off" (the browser must reload).
 */
async function backRestoresRenderedState(page, cache) {
  await page.goto(ARCHIVE_PATH);
  const startHref = await page.evaluate('location.href');
  const [item] = await markItems(page, 1);
  // Checked state of every term as rendered, and a marker that survives
  // only when Back restores this same document from the cache.
  const RENDERED = `[...document.querySelectorAll('.fe-batch-ready input[type="checkbox"][data-wpc-e-name]')].map(i => i.checked)`;
  const rendered = await page.evaluate(`(() => { window.__smokeSameDocument = true; return ${RENDERED}; })()`);
  await page.click(clickTarget(0));
  await expectChecked(page, 0, true, 'before Apply');
  await page.expectNavigation(() => page.evaluate('document.querySelector(".fe-batch-ready .fe-batch-apply").click()'));
  const applied = await page.evaluate('location.href');
  check(applied !== startHref, 'Apply did not navigate');

  page.cacheNotUsed.length = 0;
  const { currentIndex, entries } = await page.send('Page.getNavigationHistory');
  await page.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
  await page.waitUntil(`location.href === ${JSON.stringify(startHref)} && document.readyState === 'complete'`, 'Back did not return to the start page');
  await sleep(300);
  const fromCache = await page.evaluate('window.__smokeSameDocument === true');
  check(cache !== 'off' || !fromCache, 'Back restored the page from the back/forward cache although it is disabled');
  await page.waitUntil('!!document.querySelector(".fe-batch-ready .fe-batch-controls")', 'Widget missing after Back');
  // A reloaded page is a new document: mark the same term again.
  if (!fromCache) await markItems(page, 0, [item]);
  const restored = await page.evaluate(RENDERED);
  check(JSON.stringify(restored) === JSON.stringify(rendered), 'Checkbox states after Back differ from the rendered page');
  await expectChecked(page, 0, false, 'after Back');
  // The local selection matches the URL again: the same click and Apply
  // produce the same URL as before (a stale selection would drop the term).
  await page.click(clickTarget(0));
  await expectChecked(page, 0, true, 'click after Back');
  await page.expectNavigation(() => page.evaluate('document.querySelector(".fe-batch-ready .fe-batch-apply").click()'));
  const reapplied = await page.evaluate('location.href');
  check(reapplied === applied, `Apply after Back gave ${reapplied}, expected ${applied}`);
  const path = fromCache ? 'bfcache restore' : `reload (cache not used: ${page.cacheNotUsed.join('; ') || 'disabled'})`;
  return `${path}: ${item.slug} unchecked, selection matches the URL, re-Apply gives the same URL`;
}

async function replacedWrapperInitializedOnce(page) {
  await page.goto(ARCHIVE_PATH);
  const before = await page.evaluate('document.querySelectorAll(".fe-batch-controls").length');
  // Replace an ancestor of the widget with a fresh, uninitialized copy, as
  // an AJAX refresh of a sidebar would.
  const replaced = await page.evaluate(`(async () => {
    const root = document.querySelector('.fe-batch-ready');
    const ancestor = root.closest('aside, .widget') || root.parentElement;
    let depth = 0;
    for (let node = root; node !== ancestor; node = node.parentElement) depth++;
    const html = await (await fetch(location.href, { credentials: 'same-origin' })).text();
    const index = [...document.querySelectorAll('.wpc-filters-main-wrap')].indexOf(root);
    let fresh = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('.wpc-filters-main-wrap')[index];
    for (let i = 0; i < depth; i++) fresh = fresh.parentElement;
    window.__smokeOldRoot = root;
    ancestor.replaceWith(document.importNode(fresh, true));
    return ancestor.tagName.toLowerCase() + (ancestor.id ? '#' + ancestor.id : '');
  })()`);
  const COUNT = `(() => {
    const roots = [...document.querySelectorAll('.wpc-filters-main-wrap')].filter(r => r !== window.__smokeOldRoot);
    const fresh = roots.find(r => r.classList.contains('fe-batch-ready'));
    return { ready: !!fresh, ownControls: fresh ? fresh.querySelectorAll('.fe-batch-controls').length : 0,
      total: document.querySelectorAll('.fe-batch-controls').length, oldConnected: window.__smokeOldRoot.isConnected };
  })()`;
  await page.waitUntil(`${COUNT}.ready`, `Replaced widget under ${replaced} was not initialized`, 3000);
  await sleep(300);
  const afterReplace = await page.evaluate(COUNT);
  check(!afterReplace.oldConnected, 'Old widget is still in the document');
  check(afterReplace.ownControls === 1 && afterReplace.total === before,
    `Expected 1 controls block in the new widget and ${before} in total, got ${JSON.stringify(afterReplace)}`);

  // Moving the wrapper again adds an already initialized widget.
  await page.evaluate(`(() => { const a = document.querySelector('.fe-batch-ready').closest('aside, .widget') || document.querySelector('.fe-batch-ready').parentElement; a.parentElement.appendChild(a); })()`);
  await sleep(400);
  const afterMove = await page.evaluate(COUNT);
  check(afterMove.ownControls === 1 && afterMove.total === before, `Re-initialized after a move: ${JSON.stringify(afterMove)}`);
  return `${replaced} replaced and moved, 1 controls block`;
}

async function domFallbackBuildsSameQuery(page) {
  check(state.applyResult, 'Needs the Apply scenario result');
  // Keep the inline `window.feBatchApplyConfig = ...` assignment from taking effect.
  const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "Object.defineProperty(window, 'feBatchApplyConfig', { configurable: false, get() { return undefined; }, set() {} });",
  });
  try {
    await page.goto(state.applyStart);
    const blocked = await page.evaluate('window.feBatchApplyConfig === undefined && !!document.getElementById("fe-batch-apply-js-before")');
    check(blocked, 'Config was not blocked (or the inline config script is missing)');
    await markItems(page, 0, state.applyItems);
    for (const index of state.applyItems.keys()) await page.click(clickTarget(index));
    await page.expectNavigation(() => page.evaluate('document.querySelector(".fe-batch-ready .fe-batch-apply").click()'));
    const actual = await page.evaluate('location.href');
    check(actual === state.applyResult, `Fallback URL ${actual} differs from ${state.applyResult}`);
    return 'no config, same Apply URL';
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
}

async function pageWithoutWidgetIsUntouched(page) {
  await page.goto(NO_WIDGET_PATH, { widget: false });
  // The add-on stops observing after `load` when no widget exists.
  await sleep(1500);
  const result = await page.evaluate(`({
    controls: document.querySelectorAll('.fe-batch-controls, .fe-batch-ready').length,
    script: !!document.querySelector('script[src*="batch-apply.js"]'),
  })`);
  check(result.controls === 0, `Found ${result.controls} batch apply element(s)`);
  return `no batch controls (script ${result.script ? 'loaded' : 'not loaded'})`;
}

const SCENARIOS = [
  ['clicks toggle locally without navigating', clicksToggleLocally],
  ['Space/Enter toggle exactly once', keyboardTogglesOnce],
  ['Tab moves between term checkboxes', tabMovesBetweenCheckboxes],
  ['focused controls are never under the Apply/Reset box', focusNeverUnderControls],
  ['Apply sets busy state and navigates once', applyNavigatesOnce],
  ['Back restores the rendered state', page => backRestoresRenderedState(page, 'any')],
  ['replaced ancestor wrapper is initialized once', replacedWrapperInitializedOnce],
  ['DOM fallback without config builds the same query', domFallbackBuildsSameQuery],
  ['page without a widget is left untouched', pageWithoutWidgetIsUntouched],
];

// Run in a second browser without the back/forward cache.
const NO_CACHE_SCENARIOS = [
  ['Back without bfcache (reload) restores the rendered state', page => backRestoresRenderedState(page, 'off')],
];

/* ------------------------------------------------------------------
 * Runner.
 * ------------------------------------------------------------------ */

/** Runs `scenarios` in a new tab of `browser`, then closes the browser. Returns the failure count. */
async function runScenarios(browser, scenarios) {
  let failures = 0;
  let tab = null;
  let session = null;
  try {
    tab = await openTab(browser.endpoint);
    session = await connect(tab.wsUrl);
    const page = await createPage(session);
    for (const [name, scenario] of scenarios) {
      page.errors.length = 0;
      try {
        const detail = await scenario(page);
        check(page.errors.length === 0, `Page errors: ${page.errors.join(' | ')}`);
        console.log(`PASS  ${name}: ${detail}`);
      } catch (error) {
        failures++;
        console.log(`FAIL  ${name}: ${error instanceof CheckFailure ? error.message : error.stack}`);
      }
    }
  } finally {
    if (session) session.close();
    if (tab) await tab.close();
    await browser.close();
  }
  return failures;
}

async function main() {
  const executable = process.env.CDP_URL ? null : findBrowser();
  let browser;
  if (process.env.CDP_URL) {
    browser = { endpoint: process.env.CDP_URL.replace(/\/+$/, ''), close: async () => {} };
  } else {
    if (!executable) {
      console.log('SKIPPED: no Chrome or Edge found (set CHROME_PATH or CDP_URL).');
      return 0;
    }
    browser = await launchBrowser(executable);
  }

  try {
    await fetch(BASE_URL + ARCHIVE_PATH);
  } catch (error) {
    await browser.close();
    console.error(`FAIL: cannot fetch ${BASE_URL + ARCHIVE_PATH} (${(error.cause && error.cause.code) || error.message}).`);
    return 1;
  }

  console.log(`Batch Apply smoke tests on ${BASE_URL} (archive ${ARCHIVE_PATH}, no widget ${NO_WIDGET_PATH})`);
  let failures = await runScenarios(browser, SCENARIOS);
  let total = SCENARIOS.length;
  if (executable) {
    failures += await runScenarios(await launchBrowser(executable, ['--disable-features=BackForwardCache']), NO_CACHE_SCENARIOS);
    total += NO_CACHE_SCENARIOS.length;
  } else {
    console.log('NOTE  Back without bfcache is not run with CDP_URL; start that browser with --disable-features=BackForwardCache to cover it.');
  }
  console.log(failures ? `${failures} of ${total} scenarios failed.` : `All ${total} scenarios passed.`);
  return failures ? 1 : 0;
}

main().then(code => process.exit(code), error => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
