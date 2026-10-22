/* global window, document, module */
/* Filter Everything Batch Apply v0.2.0 */
(() => {
  'use strict';

  const DEFAULT_SEPARATOR = ';';
  const PAGINATION_PARAMS = ['paged', 'product-page'];
  // Apply/Reset stay busy while the next page loads. Slow servers can take
  // about 20 s to respond, so give up only well after that: a navigation
  // that never commits (Stop, cancelled unload, 204, download) must not
  // leave both buttons disabled.
  const NAVIGATION_TIMEOUT_MS = 30000;

  /* ------------------------------------------------------------------
   * Pure helpers: no DOM access, exported for the Node test suite.
   * ------------------------------------------------------------------ */

  function parseValues(raw, separator) {
    if (raw === null || raw === undefined || raw === '') return [];
    return String(raw).split(separator || DEFAULT_SEPARATOR).filter(Boolean);
  }

  function readSelection(href, param, separator) {
    const url = new URL(href);
    return new Set(parseValues(url.searchParams.get(param), separator));
  }

  function isParamList(params, length) {
    return Array.isArray(params) && params.length === length &&
      params.every(param => typeof param === 'string' && param !== '');
  }

  /** Set ID as a non-empty string of digits, or '' when absent or invalid. */
  function normalizeSetId(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return '';
    const id = String(value).trim();
    return /^[1-9]\d*$/.test(id) ? id : '';
  }

  /**
   * Filter set ID of a widget root: Filter Everything prints it in
   * `data-set` and in a `wpc-filter-set-{ID}` class. '' when neither exists.
   */
  function rootSetId(dataSet, className) {
    const fromData = normalizeSetId(dataSet);
    if (fromData) return fromData;
    const match = /(?:^|\s)wpc-filter-set-(\d+)(?=\s|$)/.exec(String(className || ''));
    return match ? normalizeSetId(match[1]) : '';
  }

  /** One config field normalized with its `kind`, or null when invalid. */
  function normalizeField(field) {
    if (!field || typeof field.eName !== 'string' || !field.eName) return null;
    const view = typeof field.view === 'string' ? field.view : '';
    const entity = typeof field.entity === 'string' ? field.entity : '';
    let kind = null;
    if (view === 'range' && isParamList(field.params, 2)) kind = 'range';
    else if (view !== 'range' && isParamList(field.params, 1)) kind = 'multi';
    if (!kind) return null;
    return { eName: field.eName, entity, view, params: [...field.params], kind, setId: normalizeSetId(field.setId) };
  }

  /**
   * Map of eName => { eName, entity, view, params, kind, setId } built from
   * the config printed by PHP. `kind` is "multi" (checkboxes/labels, one
   * param) or "range" (numeric range, min/max params). Invalid entries are
   * skipped.
   *
   * Two filter sets on one page may share an e_name with different slugs,
   * so the map is built for one widget root: with `setId`, fields of other
   * sets are left out and a field of that set wins over a set-less one.
   * Without set information (no `setId`, or no field of that set) the first
   * field per e_name wins, as in earlier versions.
   */
  function buildFieldMap(config, setId) {
    const map = new Map();
    const fields = (config && Array.isArray(config.fields) ? config.fields : []).map(normalizeField).filter(Boolean);
    const rootSet = normalizeSetId(setId);
    const scoped = rootSet !== '' && fields.some(field => field.setId === rootSet);
    for (const field of fields) {
      if (scoped && field.setId !== '' && field.setId !== rootSet) continue;
      const existing = map.get(field.eName);
      const ownSet = scoped && field.setId === rootSet;
      if (existing && (!ownSet || existing.setId === rootSet)) continue;
      map.set(field.eName, field);
    }
    return map;
  }

  /**
   * Fallback when no config is available: Filter Everything gives every
   * checkbox a full toggle URL in `data-wpc-link`. The param whose values
   * gain or lose `slug` compared with the current URL is the field param.
   */
  function deriveParamFromLink(link, currentHref, slug, separator) {
    if (!link || !slug) return null;
    let target;
    let current;
    try {
      target = new URL(link, currentHref);
      current = new URL(currentHref);
    } catch (error) {
      return null;
    }
    const keys = new Set([...target.searchParams.keys(), ...current.searchParams.keys()]);
    for (const key of keys) {
      const inTarget = parseValues(target.searchParams.get(key), separator).includes(slug);
      const inCurrent = parseValues(current.searchParams.get(key), separator).includes(slug);
      if (inTarget !== inCurrent) return key;
    }
    return null;
  }

  function safeNumber(value, fallback) {
    if (value === '' || value === null || value === undefined) return fallback;
    const number = Number(String(value).replace(',', '.'));
    return Number.isFinite(number) ? number : fallback;
  }

  /** Whole-number bounds from the native inputs' data-min/data-max/value. */
  function computeBounds(dataMin, dataMax, valueMin, valueMax) {
    const absoluteMin = safeNumber(dataMin, safeNumber(valueMin, 0));
    const absoluteMax = safeNumber(dataMax, safeNumber(valueMax, absoluteMin + 1));
    return {
      lowerBound: Math.floor(Math.min(absoluteMin, absoluteMax)),
      upperBound: Math.ceil(Math.max(absoluteMin + 1, absoluteMax)),
    };
  }

  function clampRange(min, max, lowerBound, upperBound) {
    const clampedMin = Math.max(lowerBound, Math.min(upperBound, Math.round(min)));
    const clampedMax = Math.max(clampedMin, Math.min(upperBound, Math.round(max)));
    return { min: clampedMin, max: clampedMax };
  }

  function initialRange(href, params, lowerBound, upperBound) {
    const url = new URL(href);
    return clampRange(
      safeNumber(url.searchParams.get(params[0]), lowerBound),
      safeNumber(url.searchParams.get(params[1]), upperBound),
      lowerBound,
      upperBound
    );
  }

  function isRangeApplied(href, params) {
    const url = new URL(href);
    return params.some(param => url.searchParams.has(param));
  }

  /**
   * What Apply does with one range: "keep" whatever the URL has, "clear"
   * its params, or "set" the chosen bounds. A range left at its full
   * bounds adds nothing unless the URL already restricts it.
   */
  function rangeAction(state, appliedInUrl) {
    if (!state.changed) return 'keep';
    if (state.reset) return 'clear';
    const isFullRange = state.min <= state.lowerBound && state.max >= state.upperBound;
    if (isFullRange && !appliedInUrl) return 'clear';
    return 'set';
  }

  /**
   * Visible and aria labels of a range editor. Only price ranges get the
   * currency symbol ("From (€)") and the price-specific aria labels.
   */
  function rangeLabels(strings, currencySymbol, isPrice) {
    const suffix = isPrice && currencySymbol ? ` (${currencySymbol})` : '';
    return {
      from: strings.from + suffix,
      to: strings.to + suffix,
      min: isPrice ? strings.minPrice : strings.minValue,
      max: isPrice ? strings.maxPrice : strings.maxValue,
    };
  }

  function stripPagination(url) {
    for (const param of PAGINATION_PARAMS) url.searchParams.delete(param);
    // WooCommerce may use pretty permalinks for pagination (/page/2/).
    url.pathname = url.pathname.replace(/\/page\/\d+\/?$/, '/');
    return url;
  }

  /**
   * Apply URL. Multi-value params are rewritten from the local selection;
   * unrelated params keep their place; pagination is reset. Same output
   * as 0.1.4 (multi params first, then range params).
   */
  function buildApplyUrl(href, { multi = [], ranges = [], separator = DEFAULT_SEPARATOR } = {}) {
    const url = new URL(href);
    for (const { param } of multi) url.searchParams.delete(param);
    for (const range of ranges) {
      if (range.action === 'keep') continue;
      for (const param of range.params) url.searchParams.delete(param);
    }
    stripPagination(url);
    for (const { param, values } of multi) {
      const selected = [...values];
      if (selected.length) url.searchParams.set(param, selected.join(separator));
    }
    for (const range of ranges) {
      if (range.action !== 'set') continue;
      url.searchParams.set(range.params[0], String(range.min));
      url.searchParams.set(range.params[1], String(range.max));
    }
    return url.href;
  }

  /** Reset URL: drops every managed param and pagination, keeps the rest. */
  function buildResetUrl(href, params) {
    const url = new URL(href);
    for (const param of params) url.searchParams.delete(param);
    return stripPagination(url).href;
  }

  /**
   * One pending-navigation timer: `start()` (re)arms it, `cancel()` clears
   * it, and `onExpire` runs if it was neither cancelled nor restarted.
   * `timers` is injectable for tests.
   */
  function createNavigationGuard(onExpire, { timeout = NAVIGATION_TIMEOUT_MS, timers = globalThis } = {}) {
    let timerId = null;
    const cancel = () => {
      if (timerId !== null) timers.clearTimeout(timerId);
      timerId = null;
    };
    return {
      start() {
        cancel();
        timerId = timers.setTimeout(() => {
          timerId = null;
          onExpire();
        }, timeout);
      },
      cancel,
      get pending() { return timerId !== null; },
    };
  }

  /**
   * True when mutation records added an element that is, or contains, a
   * filter widget. Only the added subtrees are queried, never the document.
   */
  function mutationsAddWidget(records, selector) {
    for (const record of records) {
      for (const node of record.addedNodes || []) {
        if (node.nodeType !== 1) continue;
        if (node.matches(selector) || node.querySelector(selector)) return true;
      }
    }
    return false;
  }

  const RANGE_STATE_KEYS = ['min', 'max', 'changed', 'reset'];

  /**
   * Copy of a widget's local state as rendered by the server: the selected
   * values per param and each range editor's chosen bounds and flags.
   */
  function snapshotState(selections, ranges) {
    return {
      selections: new Map([...selections].map(([param, values]) => [param, [...values]])),
      ranges: ranges.map(range => Object.fromEntries(RANGE_STATE_KEYS.map(key => [key, range[key]]))),
    };
  }

  /**
   * Puts a snapshot back in place. The Set and range objects are mutated,
   * not replaced, because the widget's event handlers hold them.
   */
  function restoreState(snapshot, selections, ranges) {
    for (const [param, values] of selections) {
      values.clear();
      for (const value of snapshot.selections.get(param) || []) values.add(value);
    }
    ranges.forEach((range, index) => {
      if (snapshot.ranges[index]) Object.assign(range, snapshot.ranges[index]);
    });
  }

  const helpers = {
    parseValues, readSelection, rootSetId, buildFieldMap, deriveParamFromLink, safeNumber,
    computeBounds, clampRange, initialRange, isRangeApplied, rangeAction, rangeLabels, stripPagination,
    buildApplyUrl, buildResetUrl, createNavigationGuard, NAVIGATION_TIMEOUT_MS, mutationsAddWidget,
    snapshotState, restoreState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
    return;
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ------------------------------------------------------------------
   * Browser wiring.
   * ------------------------------------------------------------------ */

  const rawConfig = window.feBatchApplyConfig;
  const hasConfig = Boolean(rawConfig && typeof rawConfig === 'object' && Array.isArray(rawConfig.fields));
  const SEPARATOR = hasConfig && typeof rawConfig.separator === 'string' && rawConfig.separator
    ? rawConfig.separator
    : DEFAULT_SEPARATOR;
  const RESET_PRESENTATION = !hasConfig || rawConfig.resetPresentation !== false;
  // English fallbacks; PHP passes the translated strings.
  const STRINGS = Object.assign({
    apply: 'Apply filters',
    reset: 'Reset',
    busy: 'Applying…',
    from: 'From',
    to: 'To',
    minPrice: 'Minimum price',
    maxPrice: 'Maximum price',
    minValue: 'Minimum',
    maxValue: 'Maximum',
  }, hasConfig && rawConfig.strings && typeof rawConfig.strings === 'object' ? rawConfig.strings : {});
  const CURRENCY = hasConfig && typeof rawConfig.currencySymbol === 'string' ? rawConfig.currencySymbol : '';

  const ROOT_SELECTOR = '.wpc-filters-main-wrap';
  const FALLBACK_ROOT_SELECTOR = '.wpc-filters-widget-wrapper';
  // Any Filter Everything widget container, supported or not.
  const WIDGET_SELECTOR = `${ROOT_SELECTOR}, ${FALLBACK_ROOT_SELECTOR}`;
  const ITEM_SELECTOR = 'li.wpc-checkbox-item, li.wpc-label-item';
  const INPUT_SELECTOR = 'input[type="checkbox"][data-wpc-e-name][data-wpc-slug]';
  const RANGE_MIN_SELECTOR = 'input.wpc-filters-range-min';
  const RANGE_MAX_SELECTOR = 'input.wpc-filters-range-max';
  const MORE_LESS_SELECTOR = 'a.wpc-toggle-a';
  const initialized = new WeakSet();
  // One controller per initialized widget. On a back/forward cache restore
  // its local state returns to the server-rendered snapshot and its busy
  // state is released; its timer is cancelled when the page is hidden.
  const widgetControllers = [];
  // Field map of each widget root, keyed by eName. With config it comes
  // from the root's filter set; without config it starts empty and fields
  // are discovered from the markup (see multiFieldFor).
  const rootFields = new WeakMap();

  function fieldsFor(root) {
    if (!rootFields.has(root)) {
      rootFields.set(root, hasConfig ? buildFieldMap(rawConfig, rootSetId(root.dataset.set, root.className)) : new Map());
    }
    return rootFields.get(root);
  }

  function multiFieldFor(input, fields) {
    const eName = input.dataset.wpcEName;
    if (hasConfig) {
      const field = fields.get(eName);
      return field && field.kind === 'multi' ? field : null;
    }
    if (fields.has(eName)) return fields.get(eName);
    const param = deriveParamFromLink(input.dataset.wpcLink, window.location.href, input.dataset.wpcSlug, SEPARATOR);
    if (!param) return null;
    const field = { eName, entity: '', view: '', params: [param], kind: 'multi' };
    fields.set(eName, field);
    return field;
  }

  function findRangePair(minInput) {
    const section = minInput.closest('.wpc-filters-section');
    const maxInput = section && section.querySelector(RANGE_MAX_SELECTOR);
    return maxInput ? { section, minInput, maxInput } : null;
  }

  function rangeFieldFor(minInput, maxInput, fields) {
    if (hasConfig) {
      const field = fields.get(minInput.dataset.wpcEName);
      return field && field.kind === 'range' ? field : null;
    }
    // Native range inputs carry their URL param in `name`.
    if (!minInput.name || !maxInput.name) return null;
    return { eName: minInput.dataset.wpcEName || '', entity: '', view: 'range', params: [minInput.name, maxInput.name], kind: 'range' };
  }

  function supportedInputs(root) {
    const fields = fieldsFor(root);
    return [...root.querySelectorAll(INPUT_SELECTOR)].filter(input => input.closest(ITEM_SELECTOR) && multiFieldFor(input, fields));
  }

  function supportedRanges(root) {
    const fields = fieldsFor(root);
    const ranges = [];
    for (const minInput of root.querySelectorAll(RANGE_MIN_SELECTOR)) {
      const pair = findRangePair(minInput);
      const field = pair && rangeFieldFor(pair.minInput, pair.maxInput, fields);
      if (field) ranges.push(Object.assign(pair, { field }));
    }
    return ranges;
  }

  function getRootCandidates() {
    let roots = [...document.querySelectorAll(ROOT_SELECTOR)];
    if (!roots.length) {
      roots = [...document.querySelectorAll(FALLBACK_ROOT_SELECTOR)];
    }
    return roots.filter(root =>
      (supportedInputs(root).length || supportedRanges(root).length) &&
      !roots.some(other => other !== root && other.contains(root))
    );
  }

  function createElement(tag, className, properties) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (properties) Object.assign(element, properties);
    return element;
  }

  function addRangeEditor({ section, minInput: originalMin, maxInput: originalMax, field }) {
    const nativeContent = section.querySelector('.wpc-filter-content');
    // Do not render duplicate inputs if this release finds unknown markup.
    // The native content wrapper is essential to preserve Folding behavior.
    if (!nativeContent || !nativeContent.contains(originalMin)) {
      console.warn('[FE Batch Apply] Unrecognized range markup; keeping the native control.');
      return null;
    }

    const { lowerBound, upperBound } = computeBounds(
      originalMin.dataset.min, originalMax.dataset.max, originalMin.value, originalMax.value
    );
    const chosen = initialRange(window.location.href, field.params, lowerBound, upperBound);
    // WooCommerce stores the product price in the `_price` meta key.
    const labels = rangeLabels(STRINGS, CURRENCY, field.eName === '_price');

    const editor = createElement('div', 'fe-batch-price-editor');
    const numbers = createElement('div', 'fe-batch-price-numbers');
    const fromInput = createElement('input', 'fe-batch-price-number', { type: 'number', step: '1' });
    const toInput = createElement('input', 'fe-batch-price-number', { type: 'number', step: '1' });
    [[labels.from, fromInput], [labels.to, toInput]].forEach(([text, input]) => {
      const label = createElement('label');
      label.append(createElement('span', '', { textContent: text }), input);
      numbers.append(label);
    });
    const dualRange = createElement('div', 'fe-batch-dual-range');
    const selection = createElement('div', 'fe-batch-range-selection');
    const fromSlider = createElement('input', 'fe-batch-range-min', { type: 'range' });
    const toSlider = createElement('input', 'fe-batch-range-max', { type: 'range' });
    fromSlider.setAttribute('aria-label', labels.min);
    toSlider.setAttribute('aria-label', labels.max);
    dualRange.append(createElement('div', 'fe-batch-range-track'), selection, fromSlider, toSlider);
    editor.append(numbers, dualRange);

    [fromInput, toInput, fromSlider, toSlider].forEach(input => {
      input.min = String(lowerBound);
      input.max = String(upperBound);
    });
    // Whole-unit increments for both slider handles and numeric fields.
    fromSlider.step = '1';
    toSlider.step = '1';

    const state = {
      params: field.params, changed: false, reset: false, min: chosen.min, max: chosen.max,
      lowerBound, upperBound, originalMin, originalMax,
    };

    const redraw = () => {
      fromInput.value = String(state.min);
      toInput.value = String(state.max);
      fromSlider.value = String(state.min);
      toSlider.value = String(state.max);
      // Do not dispatch events to Filter Everything.
      originalMin.value = String(state.min);
      originalMax.value = String(state.max);
      const span = Math.max(1, upperBound - lowerBound);
      const left = ((state.min - lowerBound) / span) * 100;
      const right = ((state.max - lowerBound) / span) * 100;
      selection.style.left = `${left}%`;
      selection.style.width = `${Math.max(0, right - left)}%`;
    };
    const update = (min, max) => {
      const next = clampRange(min, max, lowerBound, upperBound);
      state.min = next.min;
      state.max = next.max;
      state.changed = true;
      state.reset = false;
      redraw();
    };

    // Avoid reformatting a number while it is being typed. Commit on blur
    // or when the user clicks Apply.
    [fromInput, toInput].forEach(input => {
      input.addEventListener('input', () => { state.changed = true; state.reset = false; });
      input.addEventListener('change', () => state.commit());
    });
    fromSlider.addEventListener('input', () => update(Math.min(state.max, Number(fromSlider.value)), state.max));
    toSlider.addEventListener('input', () => update(state.min, Math.max(state.min, Number(toSlider.value))));
    state.commit = () => {
      const min = safeNumber(fromInput.value, lowerBound);
      const max = safeNumber(toInput.value, upperBound);
      update(Math.min(min, max), Math.max(min, max));
    };
    state.resetValue = () => {
      state.min = lowerBound;
      state.max = upperBound;
      state.changed = true;
      state.reset = true;
      redraw();
    };
    state.redraw = redraw;
    redraw();

    // Hide all of the plugin's original *range content*, including the
    // two-handle jQuery slider. Do not hide the filter header: Folding needs it.
    // Retain nodes in the DOM for plugin compatibility, but replace only UI.
    [...nativeContent.children].forEach(node => {
      node.classList.add('fe-batch-native-price-ui');
    });
    nativeContent.append(editor);
    section.classList.add('fe-batch-has-price');
    return state;
  }

  function hideNativeButtons(root) {
    const selectors = [
      '.wpc-filters-submit-button', '.wpc-filters-reset-button',
      '.wpc-filters-apply-button', '.wpc-filters-reset-a'
    ].join(',');
    root.querySelectorAll(selectors).forEach(control => {
      // Remove the floating/white panel as well, not just the label.
      const wrapper = control.closest('.wpc-sticky-buttons, .wpc-filters-widget-controls-container');
      (wrapper || control.parentElement)?.classList.add('fe-batch-native-action');
      control.classList.add('fe-batch-native-action');
    });
    // Admin-only edit link; should not appear in the storefront panel.
    root.querySelectorAll('.wpc-edit-filter-set').forEach(node => node.classList.add('fe-batch-native-action'));
  }

  /**
   * Force a predictable INITIAL view without disabling user interaction.
   * Sections start expanded; More/Less starts in its collapsed "show more" mode.
   * Filter Everything continues to handle the header and More/Less clicks.
   * Do not rerun this on every DOM mutation: a visitor may close a section
   * or expand More/Less during their current visit.
   */
  function setInitialPresentation(root) {
    if (!RESET_PRESENTATION) return;
    root.querySelectorAll('.wpc-filters-section').forEach(section => {
      if (section.classList.contains('wpc-filter-collapsible') &&
          section.querySelector('.wpc-filter-title button')) {
        section.classList.remove('wpc-closed');
        section.classList.add('wpc-opened');
        const trigger = section.querySelector('.wpc-filter-title button');
        if (trigger && trigger.hasAttribute('aria-expanded')) {
          trigger.setAttribute('aria-expanded', 'true');
        }
      }
      if (section.classList.contains('wpc-filter-more-less') &&
          section.querySelector('a.wpc-toggle-a')) {
        section.classList.remove('wpc-show-more');
        section.classList.add('wpc-show-less');
      }
    });
  }

  const isShown = element => element.getClientRects().length > 0;

  /**
   * Filter Everything prints two More/Less links per section ("See more",
   * "See less") and hides the activated one, so its focus falls back to the
   * page and an off-canvas focus trap then sends the next Tab to the panel's
   * first control. Move focus to the link now shown. After expanding, that
   * link sits below the whole list, so it is focused without scrolling and
   * the next Tab goes to the first revealed term instead of past the list.
   */
  function keepMoreLessFocus(root) {
    let revealTab = null;

    root.addEventListener('click', event => {
      const link = event.target.closest?.(MORE_LESS_SELECTOR);
      if (!link || !root.contains(link) || document.activeElement !== link) return;
      const section = link.closest('.wpc-filters-section');
      if (!section) return;
      const shownItems = () => [...section.querySelectorAll(ITEM_SELECTOR)].filter(isShown);
      const shownBefore = new Set(shownItems());
      // Filter Everything's handler is delegated to the document: it runs
      // after this one, in the same dispatch.
      window.setTimeout(() => {
        const active = document.activeElement;
        if (isShown(link) || (active && active !== link && active !== document.body)) return;
        const shown = [...section.querySelectorAll(MORE_LESS_SELECTOR)].find(other => other !== link && isShown(other));
        if (!shown) return;
        const revealed = shownItems().find(li => !shownBefore.has(li));
        shown.focus({ preventScroll: Boolean(revealed) });
        const firstTerm = revealed && revealed.querySelector('input, a[href]:not([tabindex="-1"])');
        revealTab = firstTerm && document.activeElement === shown ? { from: shown, to: firstTerm } : null;
      }, 0);
    });

    root.addEventListener('keydown', event => {
      if (!revealTab || event.key !== 'Tab') return;
      const { from, to } = revealTab;
      revealTab = null;
      if (event.target !== from || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      to.focus();
      if (document.activeElement === to) event.preventDefault();
    }, true);

    root.addEventListener('focusout', event => {
      if (revealTab && event.target === revealTab.from) revealTab = null;
    });
  }

  function init(root) {
    if (initialized.has(root)) return;
    initialized.add(root);

    const fields = fieldsFor(root);
    const inputs = supportedInputs(root);
    // Config order keeps the 0.1.4 param order; discovered fields follow the DOM.
    const multiFields = hasConfig
      ? [...fields.values()].filter(field => field.kind === 'multi')
      : [...new Set(inputs.map(input => multiFieldFor(input, fields)))];
    const selections = new Map(multiFields.map(field =>
      [field.params[0], readSelection(window.location.href, field.params[0], SEPARATOR)]
    ));
    const selectionFor = input => {
      const field = multiFieldFor(input, fields);
      return field ? selections.get(field.params[0]) || null : null;
    };
    // Server-checked terms come from the `checked` attribute: when Back
    // reloads the page (no back/forward cache, e.g. `Cache-Control: no-store`
    // for logged-in users) the browser restores the `checked` property the
    // visitor left behind, before (Firefox) or after (Chrome, at `load`)
    // this runs.
    for (const input of inputs) {
      if (input.defaultChecked) selectionFor(input)?.add(input.dataset.wpcSlug);
    }

    // Sync all locally-rendered checkboxes from our local state.
    const syncInputs = () => {
      for (const input of root.querySelectorAll(INPUT_SELECTOR)) {
        const set = selectionFor(input);
        if (!set) continue;
        const isChecked = set.has(input.dataset.wpcSlug);
        input.checked = isChecked;
        input.closest(ITEM_SELECTOR)?.classList.toggle('wpc-term-selected', isChecked);
      }
    };
    syncInputs();

    const ranges = supportedRanges(root).map(addRangeEditor).filter(Boolean);
    // State as rendered for this URL. A back/forward cache restore brings
    // back the page with whatever the visitor changed before leaving it.
    const renderedState = snapshotState(selections, ranges);
    const managedParams = hasConfig
      ? [...fields.values()].flatMap(field => field.params)
      : [...multiFields.flatMap(field => field.params), ...ranges.flatMap(range => range.params)];

    const toggle = input => {
      const set = selectionFor(input);
      const slug = input.dataset.wpcSlug;
      if (set.has(slug)) set.delete(slug);
      else set.add(slug);
    };

    // Term whose Space key-down already toggled it (see the key handlers).
    let keyClickInput = null;

    // Stop propagation before Filter Everything's delegated listeners run.
    root.addEventListener('click', event => {
      const li = event.target.closest?.(ITEM_SELECTOR);
      if (!li || !root.contains(li)) return;
      const input = li.querySelector(INPUT_SELECTOR);
      if (!input || !selectionFor(input)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Keyboard click following a Space already toggled on key-down.
      if (input === keyClickInput && event.detail === 0) {
        keyClickInput = null;
        window.setTimeout(syncInputs, 0);
        return;
      }
      toggle(input);
      // Native checkbox default action may undo `.checked` after preventDefault.
      window.setTimeout(syncInputs, 0);
    }, true);

    // One tab stop per term: the checkbox. The term link inside its label
    // still names the checkbox and still toggles it on click.
    for (const input of inputs) {
      input.closest(ITEM_SELECTOR).querySelectorAll('a[href]').forEach(link => { link.tabIndex = -1; });
    }

    // Space and Enter on a focused term (its checkbox, or its link after a
    // mouse click focused it) toggle it here exactly once. Their defaults
    // are prevented: Space would scroll the page from a link, Enter would
    // follow the link or submit a form. A browser that still clicks the
    // checkbox on the Space key-up gets that click swallowed above.
    const keyTerm = el => {
      const li = el.closest?.(ITEM_SELECTOR);
      const input = li && root.contains(li) ? li.querySelector(INPUT_SELECTOR) : null;
      return input && selectionFor(input) ? input : null;
    };
    root.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const input = keyTerm(event.target);
      if (!input) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      toggle(input);
      syncInputs();
      if (event.key === ' ') keyClickInput = input;
    }, true);
    root.addEventListener('keyup', event => {
      if (event.key !== ' ' || !keyClickInput) return;
      event.preventDefault();
      window.setTimeout(() => { keyClickInput = null; }, 0);
    }, true);

    const controls = createElement('div', 'fe-batch-controls');
    const applyButton = createElement('button', 'fe-batch-apply', { type: 'button', textContent: STRINGS.apply });
    const resetButton = createElement('button', 'fe-batch-reset', { type: 'button', textContent: STRINGS.reset });
    controls.append(applyButton, resetButton);
    root.append(controls);
    root.classList.add('fe-batch-ready');
    hideNativeButtons(root);
    setInitialPresentation(root);
    keepMoreLessFocus(root);

    // While a navigation is pending both buttons are disabled, so a second
    // click cannot queue another request.
    let busy = false;
    const setBusy = (value, clicked) => {
      busy = value;
      for (const button of [applyButton, resetButton]) {
        button.disabled = value;
        if (value && button === clicked) button.setAttribute('aria-busy', 'true');
        else button.removeAttribute('aria-busy');
      }
      applyButton.textContent = value && clicked === applyButton ? STRINGS.busy : STRINGS.apply;
    };
    const releaseBusy = () => setBusy(false);
    const navigationGuard = createNavigationGuard(releaseBusy);
    const navigate = (href, clicked) => {
      setBusy(true, clicked);
      navigationGuard.start();
      window.location.assign(href);
    };
    widgetControllers.push({
      release() {
        navigationGuard.cancel();
        releaseBusy();
      },
      restore() {
        restoreState(renderedState, selections, ranges);
        this.resync();
      },
      // Inputs back in line with the local state (browser form restoration
      // may have changed checkboxes and editor fields behind its back).
      resync() {
        syncInputs();
        ranges.forEach(range => range.redraw());
      },
      cancelTimer: navigationGuard.cancel,
    });

    // Reset clears BOTH locally pending and already-applied criteria.
    // On an already filtered URL it navigates once, removing the visible chips.
    // If nothing is applied yet, it simply clears the pending selections.
    resetButton.addEventListener('click', () => {
      if (busy) return;
      for (const set of selections.values()) set.clear();
      ranges.forEach(range => range.resetValue());
      syncInputs();
      const cleanUrl = buildResetUrl(window.location.href, managedParams);
      if (cleanUrl !== window.location.href) {
        navigate(cleanUrl, resetButton);
      } else {
        applyButton.focus();
      }
    });

    applyButton.addEventListener('click', () => {
      if (busy) return;
      const href = buildApplyUrl(window.location.href, {
        separator: SEPARATOR,
        multi: multiFields.map(field => ({ param: field.params[0], values: selections.get(field.params[0]) })),
        ranges: ranges.map(range => {
          if (range.changed && !range.reset) range.commit();
          const action = rangeAction(range, isRangeApplied(window.location.href, range.params));
          return { params: range.params, action, min: range.min, max: range.max };
        }),
      });
      if (href !== window.location.href) {
        navigate(href, applyButton);
      }
    });
  }

  function initializeAll() {
    for (const root of getRootCandidates()) init(root);
  }

  /**
   * Filter Everything (or a theme) may replace the widget, or any wrapper
   * around it, after an AJAX request. The whole body is observed, but each
   * batch of mutations only inspects its added subtrees; a full scan runs,
   * debounced, only when a widget was added. init() is idempotent.
   */
  let pending = false;
  const observer = new MutationObserver(records => {
    if (pending || !mutationsAddWidget(records, WIDGET_SELECTOR)) return;
    pending = true;
    window.setTimeout(() => {
      pending = false;
      initializeAll();
    }, 50);
  });

  function start() {
    initializeAll();
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  /**
   * Filter Everything can report filters for a page whose theme renders no
   * widget (for example a product search without a sidebar). Do not keep
   * observing such a page: once it has loaded without any widget, stop.
   * Trade-off: a widget first injected after `load` on that page is not
   * handled; widgets present at load keep being watched for replacements.
   */
  const stopIfNoWidget = () => {
    if (!document.querySelector(WIDGET_SELECTOR)) observer.disconnect();
  };
  if (document.readyState === 'complete') {
    stopIfNoWidget();
  } else {
    window.addEventListener('load', stopIfNoWidget, { once: true });
  }

  // The page is unloading or entering the back/forward cache: the pending
  // navigation committed, so its timeout must not fire later.
  window.addEventListener('pagehide', () => {
    widgetControllers.forEach(controller => controller.cancelTimer());
  });

  // A back/forward cache restore is a navigation without a new page load:
  // the DOM and this script's state are as the visitor left them (for
  // example a term checked right before Apply), so return every widget to
  // what the server rendered for this URL.
  // Without that cache, Back reloads the page and the browser restores form
  // control state; Chrome does it just before `load`, after init. The local
  // state is already the rendered one, so only the inputs are redrawn.
  window.addEventListener('pageshow', event => {
    if (!event.persisted) {
      widgetControllers.forEach(controller => controller.resync());
      return;
    }
    widgetControllers.forEach(controller => {
      controller.restore();
      controller.release();
    });
    for (const root of getRootCandidates()) setInitialPresentation(root);
  });
})();
