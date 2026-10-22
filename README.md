# Filter Everything Batch Apply

A small add-on for [Filter Everything](https://wordpress.org/plugins/filter-everything/) (free edition) on WooCommerce shops.

Shoppers tick several filter options and adjust price ranges **locally**, with no request per click. One **Apply filters** button then loads the filtered page once, using Filter Everything's own URL parameters, so Filter Everything still runs the query.

No configuration is needed. The add-on reads the fields of the filter sets shown on the current page and never modifies WooCommerce, the theme or Filter Everything.

## Requirements

- WordPress 6.5 or later.
- PHP 7.4 or later.
- Filter Everything 1.9+ (free) active.
- Filter Everything URLs in query-string mode (the default in the free edition).

## Installation

1. Upload the `filter-everything-batch-apply` folder to `wp-content/plugins/`, or upload the ZIP from *Plugins > Add New > Upload Plugin*.
2. Activate it. WordPress requires Filter Everything to be active first.
3. Open a page where a Filter Everything filter set is displayed and try it.

Deactivating the add-on restores Filter Everything's original behavior.

## What it handles

| Filter Everything view | Behavior |
|---|---|
| Checkboxes | Selected locally; written on Apply |
| Labels | Selected locally; written on Apply |
| Range (numeric meta such as price, or numeric taxonomy) | Replaced by a local editor: two number inputs and a two-handle slider |
| Radio, dropdown, rating, date, range list, search | Left untouched; they keep Filter Everything's native behavior |

The add-on also:

- Hides Filter Everything's own Apply/Reset buttons and adds **Apply filters** and **Reset** at the bottom of the widget.
- Opens collapsible sections and starts More/Less collapsed on every page load, clearing only Filter Everything's presentation cookies (`wpcContainersStatus`, `wpcMoreLessStatus`). This can be turned off with a filter (see below).
- Hides the repeated list of selected terms under section titles; the active-filter chips still show them.

## URL behavior

- Multi-value fields use the field's URL slug with Filter Everything's separator, for example `?color=red%3Bblue` (`;` encoded by the browser).
- Ranges use `min_{slug}` and `max_{slug}`.
- Unrelated parameters (such as `orderby`) are preserved.
- Pagination is reset: `paged`, `product-page` and `/page/N/` are removed.
- A range left at its full bounds adds no parameters, unless a range was already applied in the URL.
- An applied range that is not touched is kept as is.
- **Reset** clears pending and applied selections of the handled fields. When the URL has filters, it loads the unfiltered page once.
- While the page is loading, Apply and Reset are disabled so a second click cannot send another request.

## Limits

- **Path permalinks** (Filter Everything PRO, filters in the URL path) are not supported. The add-on stays inactive in that mode.
- **Range bounds are not recalculated** while selecting. They come from the bounds Filter Everything rendered for the current page, so they may not match every combination of pending selections.
- Range editors use whole-number steps.
- Only the views listed above are intercepted; every other view keeps its native behavior.
- The add-on loads only on pages where Filter Everything renders at least one supported field.

## Filters

| Hook | Default | Purpose |
|---|---|---|
| `fe_batch_apply_fields` | Supported fields of the page | Array of `{ eName, entity, view, params, setId }` handled by the add-on (`setId`, the owning filter set, is optional). Return an empty array to disable it on a page. |
| `fe_batch_apply_reset_presentation` | `true` | Return `false` to keep the visitor's open/closed sections and More/Less state instead of resetting them on each load. |

```php
// Keep visitors' folding preferences.
add_filter('fe_batch_apply_reset_presentation', '__return_false');
```

## Translations

Text domain: `fe-batch-apply`. Source strings are English. A Spanish (es_ES) translation is included in `languages/` as `.po` and WordPress 6.5+ `.l10n.php` files; `fe-batch-apply.pot` is the template for new languages. The currency symbol comes from WooCommerce.

## Development

Pure URL and config helpers in `assets/batch-apply.js` are covered by Node's built-in test runner (no dependencies):

```sh
node --test "tests/*.test.js"
```

Browser smoke tests in `tests/e2e/smoke.mjs` drive a local Chrome or Edge over the DevTools protocol (Node 24, no dependencies) against a running site with Filter Everything and this add-on active. They check click and keyboard toggles (one tab stop per term, no scroll on Space, focused controls never under the Apply/Reset box, modified keys ignored, no stale Space state), the Apply busy state and query, the state shown after Back (from the back/forward cache, and in a second browser launched without it, where Back reloads the page), re-initialization after a replaced wrapper, the DOM fallback without configuration, and a page without a widget. They are not part of the unit test run:

```sh
node tests/e2e/smoke.mjs
BASE_URL=https://shop.test ARCHIVE_PATH=/product-category/shirts/ node tests/e2e/smoke.mjs
```

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | `http://localhost:8080` | Site root. |
| `ARCHIVE_PATH` | `/shop/` | Page that renders a filter widget with at least two checkbox or label fields. |
| `NO_WIDGET_PATH` | `/?s=camiseta&post_type=product` | Page without a filter widget. |
| `CHROME_PATH` | Common Chrome/Edge install paths | Browser executable. |
| `CDP_URL` | (unset) | Attach to a browser started with `--remote-debugging-port` instead of launching one. |

The script exits with 0 when every scenario passes, 1 on a failure, and prints `SKIPPED` with exit 0 when no browser is found. The Back scenario reports whether the page came from the back/forward cache or was reloaded (with the browser's reasons); both paths are asserted. With `CDP_URL` the second, cache-less browser is not launched. In Git Bash on Windows, prefix the command with `MSYS_NO_PATHCONV=1` so path variables are not rewritten.

## Changelog

### 0.2.0

- Zero configuration: fields, URL parameters and the multi-value separator come from Filter Everything for the current page instead of a hardcoded map.
- Loads on any page where Filter Everything renders supported fields (including brand archives); stays inactive without supported fields or with path permalinks.
- Supports the Labels view and any number of numeric range fields.
- DOM fallback that derives parameters from Filter Everything's markup when no configuration is available.
- Translatable English strings, Spanish translation, currency symbol from WooCommerce.
- Busy state on Apply/Reset, no range parameters for untouched full ranges, single toggle on Space/Enter, narrower DOM observation.
- Apply/Reset leave the busy state after 30 seconds when the navigation never commits (Stop, cancelled unload, 204 response or download).
- Widgets added after load, or re-added when any wrapper around them is replaced, are initialized once; the observer only inspects added nodes.
- Stops observing the page after `load` when no Filter Everything widget was rendered (for example a product search without a sidebar); a widget first injected later on such a page is not handled.
- Fields are resolved per filter set: two sets on one page that share a field source with different URL slugs each write their own parameter. Without set information, fields match by source name as before.
- Back and Forward restore each widget to the state rendered for that URL (checked terms and range editors) when the browser brings the page back from its back/forward cache, instead of showing the selection left before navigating away.
- Back without the back/forward cache (for example logged-in visitors, whose pages are sent with `Cache-Control: no-store`): server-checked terms are read from the `checked` attribute, and checkboxes and range editors are redrawn on `pageshow`, after the browser restores the form state left before Apply.
- Keyboard: each term has a single tab stop (its checkbox; the term link is taken out of the tab order), Space and Enter toggle the focused term once without scrolling or following the link (with Shift, Ctrl, Alt or Meta the key is left to the browser), and term checkboxes, range fields and handles, section toggles and Apply/Reset show a visible focus ring.
- More/Less keeps keyboard focus: activating "See more" or "See less" moves focus to the link Filter Everything shows in its place (instead of dropping it on the page), and after expanding the next Tab goes to the first revealed term.
- A focused control is never left under the sticky Apply/Reset box: its scroll container (or the window) scrolls just enough to show it with a 12px gap, smoothly unless the visitor prefers reduced motion.
- A Space key-up lost when focus moves no longer swallows a later click without a pointer (screen reader activation).
- `fe_batch_apply_fields` and `fe_batch_apply_reset_presentation` filters.
- Requires WordPress 6.5 and declares the Filter Everything dependency.

### 0.1.x

Initial versions built for a single shop: local checkbox selection with one Apply navigation, a local price editor with whole-unit steps, Reset clearing pending and applied filters, hidden native buttons, sticky action panel, and an initial open/collapsed presentation.
