/* global window, document */
/* Filter Everything Batch Apply, proof of concept v0.1.4 */
(() => {
  'use strict';

  // Specific to the taxonomy slugs and filter URL names of this shop.
  const FIELDS = Object.freeze({
    pa_colores: 'filtro_color',
    pa_talla: 'filtro_talla',
    product_brand: 'filtro_marca',
    product_cat: 'filtro_categoria',
  });
  const PRICE_MIN = 'min_filtro_precio';
  const PRICE_MAX = 'max_filtro_precio';
  const ROOT_SELECTOR = '.wpc-filters-main-wrap';
  const ITEM_SELECTOR = 'li.wpc-checkbox-item';
  const INPUT_SELECTOR = 'input[type="checkbox"][data-wpc-e-name][data-wpc-slug]';
  const initialized = new WeakSet();

  function getRootCandidates() {
    let roots = [...document.querySelectorAll(ROOT_SELECTOR)];
    if (!roots.length) {
      roots = [...document.querySelectorAll('.wpc-filters-widget-wrapper')];
    }
    return roots.filter(root =>
      root.querySelector(INPUT_SELECTOR) &&
      !roots.some(other => other !== root && other.contains(root))
    );
  }

  function getSelectionsFromUrl() {
    const url = new URL(window.location.href);
    const selected = new Map();
    for (const key of Object.values(FIELDS)) {
      const raw = url.searchParams.get(key) || '';
      selected.set(key, new Set(raw.split(';').filter(Boolean)));
    }
    return selected;
  }

  function safeNumber(value, fallback) {
    if (value === '' || value === null || value === undefined) return fallback;
    const number = Number(String(value).replace(',', '.'));
    return Number.isFinite(number) ? number : fallback;
  }

  function addPriceEditor(root) {
    const originalMin = root.querySelector('input.wpc-filters-range-min');
    const originalMax = root.querySelector('input.wpc-filters-range-max');
    if (!originalMin || !originalMax) return null;

    const section = originalMin.closest('.wpc-filters-section');
    if (!section || !section.contains(originalMax)) return null;
    const nativeContent = section.querySelector('.wpc-filter-content');
    // Do not render duplicate inputs if this release finds unknown markup.
    // The native content wrapper is essential to preserve Folding behavior.
    if (!nativeContent || !nativeContent.contains(originalMin)) {
      console.warn('[FE Batch Apply] Estructura de precio no reconocida; sin reemplazo visual.');
      return null;
    }

    const absoluteMin = safeNumber(originalMin.dataset.min, safeNumber(originalMin.value, 0));
    const absoluteMax = safeNumber(originalMax.dataset.max, safeNumber(originalMax.value, absoluteMin + 1));
    const lowerBound = Math.floor(Math.min(absoluteMin, absoluteMax));
    const upperBound = Math.ceil(Math.max(absoluteMin + 1, absoluteMax));
    const applied = new URL(window.location.href);
    let chosenMin = safeNumber(applied.searchParams.get(PRICE_MIN), lowerBound);
    let chosenMax = safeNumber(applied.searchParams.get(PRICE_MAX), upperBound);
    chosenMin = Math.max(lowerBound, Math.min(upperBound, Math.round(chosenMin)));
    chosenMax = Math.max(chosenMin, Math.min(upperBound, Math.round(chosenMax)));

    const editor = document.createElement('div');
    editor.className = 'fe-batch-price-editor';
    editor.innerHTML = `
      <div class="fe-batch-price-numbers">
        <label><span>Desde (€)</span><input class="fe-batch-price-number" type="number" step="1"></label>
        <label><span>Hasta (€)</span><input class="fe-batch-price-number" type="number" step="1"></label>
      </div>
      <div class="fe-batch-dual-range">
        <div class="fe-batch-range-track"></div>
        <div class="fe-batch-range-selection"></div>
        <input type="range" class="fe-batch-range-min" aria-label="Precio mínimo">
        <input type="range" class="fe-batch-range-max" aria-label="Precio máximo">
      </div>`;

    const [fromInput, toInput] = editor.querySelectorAll('.fe-batch-price-number');
    const fromSlider = editor.querySelector('.fe-batch-range-min');
    const toSlider = editor.querySelector('.fe-batch-range-max');
    const selection = editor.querySelector('.fe-batch-range-selection');
    [fromInput, toInput, fromSlider, toSlider].forEach(input => {
      input.min = String(lowerBound);
      input.max = String(upperBound);
    });
    // One-euro increments for both slider handles and numeric fields.
    fromSlider.step = '1';
    toSlider.step = '1';

    const state = {
      changed: false, reset: false, min: chosenMin, max: chosenMax,
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
      state.min = Math.max(lowerBound, Math.min(upperBound, Math.round(min)));
      state.max = Math.max(state.min, Math.min(upperBound, Math.round(max)));
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
    redraw();

    // Hide all of the plugin's original *price content*, including the
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
   * Sections start expanded; More/Less starts in "show 5 / Ver más" mode.
   * Filter Everything continues to handle the header and More/Less clicks.
   * Do not rerun this on every DOM mutation: a visitor may close a section
   * or choose Ver más during their current visit.
   */
  function setInitialPresentation(root) {
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

  function init(root) {
    if (initialized.has(root)) return;
    initialized.add(root);

    const selections = getSelectionsFromUrl();
    const inputs = [...root.querySelectorAll(INPUT_SELECTOR)];
    for (const input of inputs) {
      const param = FIELDS[input.dataset.wpcEName];
      if (!param) continue;
      if (input.checked) selections.get(param).add(input.dataset.wpcSlug);
    }

    // Sync all locally-rendered checkboxes from our local state.
    const syncInputs = () => {
      for (const input of root.querySelectorAll(INPUT_SELECTOR)) {
        const param = FIELDS[input.dataset.wpcEName];
        if (!param) continue;
        const isChecked = selections.get(param).has(input.dataset.wpcSlug);
        input.checked = isChecked;
        input.closest(ITEM_SELECTOR)?.classList.toggle('wpc-term-selected', isChecked);
      }
    };
    syncInputs();

    const price = addPriceEditor(root);

    // Stop propagation before Filter Everything's delegated listeners run.
    root.addEventListener('click', event => {
      const li = event.target.closest?.(ITEM_SELECTOR);
      if (!li || !root.contains(li)) return;
      const input = li.querySelector(INPUT_SELECTOR);
      const param = input && FIELDS[input.dataset.wpcEName];
      if (!param) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const slug = input.dataset.wpcSlug;
      const set = selections.get(param);
      const nextChecked = !set.has(slug);
      if (nextChecked) set.add(slug);
      else set.delete(slug);
      // Native checkbox default action may undo `.checked` after preventDefault.
      window.setTimeout(syncInputs, 0);
    }, true);

    root.addEventListener('keydown', event => {
      const el = event.target;
      if (!el.matches?.(INPUT_SELECTOR)) return;
      if (event.key !== ' ' && event.key !== 'Enter') return;
      const param = FIELDS[el.dataset.wpcEName];
      if (!param) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const set = selections.get(param);
      if (set.has(el.dataset.wpcSlug)) set.delete(el.dataset.wpcSlug);
      else set.add(el.dataset.wpcSlug);
      syncInputs();
    }, true);

    const controls = document.createElement('div');
    controls.className = 'fe-batch-controls';
    const applyButton = document.createElement('button');
    applyButton.type = 'button';
    applyButton.className = 'fe-batch-apply';
    applyButton.textContent = 'Aplicar filtros';
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'fe-batch-reset';
    resetButton.textContent = 'Restablecer';
    controls.append(applyButton, resetButton);
    root.append(controls);
    root.classList.add('fe-batch-ready');
    hideNativeButtons(root);
    setInitialPresentation(root);

    resetButton.addEventListener('click', () => {
      for (const key of Object.values(FIELDS)) selections.get(key).clear();
      price?.resetValue();
      syncInputs();
      const cleanUrl = buildBaseUrl();
      if (cleanUrl.href !== window.location.href) {
        // A single navigation removes active filters and their chip summaries.
        window.location.assign(cleanUrl.href);
      } else {
        // No applied filters; clear only the pending choices in this widget.
        applyButton.focus();
      }
    });

    // Reset should clear BOTH locally pending and already-applied criteria.
    // On an already filtered URL it navigates once, removing the visible chips.
    // If nothing is applied yet, it simply clears the pending selections.
    const buildBaseUrl = (clearPrice = true) => {
      const url = new URL(window.location.href);
      for (const key of Object.values(FIELDS)) url.searchParams.delete(key);
      if (clearPrice) {
        url.searchParams.delete(PRICE_MIN);
        url.searchParams.delete(PRICE_MAX);
      }
      url.searchParams.delete('paged');
      url.searchParams.delete('product-page');
      url.pathname = url.pathname.replace(/\/page\/\d+\/?$/, '/');
      return url;
    };

    applyButton.addEventListener('click', () => {
      if (price && price.changed && !price.reset) price.commit();
      const url = buildBaseUrl(Boolean(price?.changed));
      for (const key of Object.values(FIELDS)) {
        const selected = selections.get(key);
        if (selected.size) url.searchParams.set(key, [...selected].join(';'));
      }
      if (price?.changed) {
        if (!price.reset) {
          url.searchParams.set(PRICE_MIN, String(price.min));
          url.searchParams.set(PRICE_MAX, String(price.max));
        }
      }
      url.searchParams.delete('paged');
      url.searchParams.delete('product-page');
      // WooCommerce may use pretty permalinks for pagination (/page/2/).
      url.pathname = url.pathname.replace(/\/page\/\d+\/?$/, '/');
      if (url.href !== window.location.href) {
        window.location.assign(url.href);
      }
    });
  }

  function initializeAll() {
    for (const root of getRootCandidates()) init(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAll, { once: true });
  } else {
    initializeAll();
  }

  // A back/forward cache restore is a navigation without a new page load.
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    for (const root of getRootCandidates()) setInitialPresentation(root);
  });

  let pending = false;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    window.setTimeout(() => {
      pending = false;
      initializeAll();
    }, 50);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
