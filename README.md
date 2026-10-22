# Filter Everything Batch Apply

Stop waiting for an AJAX request on every filter click. This add-on for [Filter Everything](https://wordpress.org/plugins/filter-everything/) (free edition) on WooCommerce lets shoppers pick several options and a price range **without any request**, then loads the filtered page **once** when they press **Apply filters**.

On a shop where each filter request takes several seconds, choosing four options goes from four waits to one. Filter Everything still runs the query, with its own URL parameters. Nothing to configure, and WooCommerce, the theme and Filter Everything are never modified.

> **Status:** 0.2.0 is unreleased. 0.1.x runs in production on one shop.

## Quick start

1. Make sure Filter Everything is active and shows a filter set on your shop pages.
2. Download `filter-everything-batch-apply.zip` from the [latest release](https://github.com/eliseumarmon/filter-everything-batch-apply/releases/latest) (or build it, see [Packaging](#packaging)) and install it from *Plugins > Add New > Upload Plugin*.
3. Activate it, open a shop page, tick a few options and press **Apply filters**: one page load, no requests while ticking.

Deactivating the add-on restores Filter Everything's native behavior.

## Requirements

| | Minimum |
|---|---|
| WordPress | 6.5 |
| PHP | 7.4 |
| Filter Everything | 1.9 (free), active |
| Filter Everything URLs | Query-string mode (the free edition's default) |

## How it works

The add-on reads the fields of the filter sets Filter Everything renders on the current page and takes over only the views it can handle locally.

| Filter Everything view | What the add-on does |
|---|---|
| Checkboxes, Labels | Selection is kept locally and written to the URL on Apply |
| Range (price or other numeric field) | Replaced by two number inputs and a two-handle slider, applied on Apply |
| Radio, dropdown, rating, date, range list, search | Not touched: native Filter Everything behavior |

It also replaces Filter Everything's Apply/Reset buttons with its own **Apply filters** and **Reset** (sticky at the bottom of the widget), and hides the repeated list of selected terms under section titles, since the active-filter chips already show them.

### URL rules

| Case | Result |
|---|---|
| Several values in one field | Filter Everything's slug and separator, e.g. `?color=red%3Bblue` |
| Range | `min_{slug}` and `max_{slug}`; omitted when left at full bounds |
| Unrelated parameters (`orderby`, …) | Kept |
| Pagination (`paged`, `product-page`, `/page/N/`) | Reset |
| **Reset** | Clears pending and applied selections; loads the unfiltered page once if the URL had filters |
| Second click while loading | Ignored (buttons are busy; released after 30 s if the page never loads) |

### Accessibility

One tab stop per term, Space/Enter toggle without scrolling, visible focus rings, focus kept on More/Less, focused controls never hidden behind the sticky buttons, and Back/Forward always show the state of the page you return to.

## Limits

- **Path permalinks** (Filter Everything PRO) are not supported; the add-on stays inactive in that mode.
- **Range bounds are not recalculated** while selecting: they are the bounds rendered for the current page.
- Ranges use whole-number steps.
- The add-on only reduces the number of requests. The time of the final page load depends on your server and on Filter Everything.

## Hooks

| Filter | Default | Use |
|---|---|---|
| `fe_batch_apply_fields` | Supported fields of the page | Array of `{ eName, entity, view, params, setId }`. Return `[]` to disable the add-on on a page. |
| `fe_batch_apply_update_repo` | `eliseumarmon/filter-everything-batch-apply` | GitHub repository (`owner/repo`) whose releases provide updates, see [Updates](#updates). |
| `fe_batch_apply_reset_presentation` | `true` | By default sections start open and More/Less collapsed on every load (only Filter Everything's presentation cookies are cleared). Return `false` to keep the visitor's choices. |

```php
// Keep visitors' open/closed sections and More/Less state.
add_filter('fe_batch_apply_reset_presentation', '__return_false');
```

## Translations

Text domain `fe-batch-apply`; source strings in English. Spanish (`es_ES`) ships in `languages/` (`.po` and WordPress 6.5+ `.l10n.php`); start new languages from `fe-batch-apply.pot`. The currency symbol comes from WooCommerce.

## Updates

Updates come from this repository's public GitHub releases, with no token and no extra plugin. WordPress shows a new version in *Plugins* and *Dashboard > Updates* like any other plugin, and the add-on installs it with one click.

- The version is the release tag (`v0.3.0` → 0.3.0) and the package is its `filter-everything-batch-apply.zip` asset. A release without that asset is ignored.
- To update without clicking, choose *Enable auto-updates* for the add-on in *Plugins*.
- GitHub allows 60 unauthenticated API requests per hour per IP. The add-on asks at most once every 6 hours (once an hour after a failure), so a shared host stays far below the limit; a failed check only delays the update.
- A fork can publish its own releases and point the updater at them:

```php
add_filter('fe_batch_apply_update_repo', function () {
    return 'your-name/filter-everything-batch-apply';
});
```

## Development

| Check | Command | Needs |
|---|---|---|
| Unit tests (URL and config helpers) | `node --test "tests/*.test.js"` | Node 24 |
| Browser smoke tests | `node tests/e2e/smoke.mjs` | Node 24, Chrome or Edge, a running site with Filter Everything and the add-on |

No npm dependencies. The smoke tests drive a headless browser over the DevTools protocol and cover clicks and keyboard, the Apply busy state and query, Back with and without the back/forward cache, re-initialization of a replaced widget, the DOM fallback without configuration, and a page without a widget. They exit 0 on success, 1 on failure, and print `SKIPPED` (exit 0) when no browser is found.

```sh
BASE_URL=https://shop.test ARCHIVE_PATH=/product-category/shirts/ node tests/e2e/smoke.mjs
```

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | `http://localhost:8080` | Site root |
| `ARCHIVE_PATH` | `/shop/` | Page with a filter widget that has at least two checkbox or label fields |
| `NO_WIDGET_PATH` | `/?s=camiseta&post_type=product` | Page without a filter widget |
| `CHROME_PATH` | Common Chrome/Edge paths | Browser executable |
| `CDP_URL` | unset | Attach to a browser started with `--remote-debugging-port` (skips the second, cache-less browser) |

In Git Bash on Windows, prefix commands with `MSYS_NO_PATHCONV=1` so path variables are not rewritten.

### Packaging

`tests/` and `.github/` are excluded from archives, so the ZIP contains only what WordPress needs:

```sh
git archive --format=zip --prefix=filter-everything-batch-apply/ -o filter-everything-batch-apply.zip HEAD
```

### Releasing

1. Bump the `Version:` header and `FE_BATCH_APPLY_VERSION` in `filter-everything-batch-apply.php`, and add a `### X.Y.Z` section to the [Changelog](#changelog).
2. Commit, then tag and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The [release workflow](.github/workflows/release.yml) checks that the tag matches the plugin version, builds the ZIP with `git archive` and publishes the GitHub release with that changelog section as notes. Sites pick it up on their next update check.

## Changelog

### 0.2.0 (unreleased)

- **Zero configuration:** fields, URL parameters and separator come from Filter Everything for each page and filter set; a DOM fallback covers pages without configuration.
- Works on any page where Filter Everything renders supported fields (shop, categories, tags, brands); inactive elsewhere and with path permalinks.
- Labels view and any number of numeric ranges.
- Translatable strings, Spanish translation, WooCommerce currency symbol.
- Busy Apply/Reset that cannot be double-submitted; untouched full ranges add no parameters.
- Back/Forward show the state of the page you return to, with or without the back/forward cache.
- Keyboard and focus improvements (see [Accessibility](#accessibility)).
- Robust re-initialization when the widget is replaced, and no work on pages without a widget.
- `fe_batch_apply_fields` and `fe_batch_apply_reset_presentation` filters; requires WordPress 6.5 and declares the Filter Everything dependency.
- Automatic updates from GitHub releases (see [Updates](#updates)), published by a tag-triggered release workflow.

### 0.1.x

Built for a single shop: local checkbox selection with one Apply navigation, a local price editor, Reset, hidden native buttons and a sticky action panel.

## License

GPL-2.0-or-later.
