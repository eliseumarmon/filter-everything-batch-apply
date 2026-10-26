# Changelog

Notable changes per release. Each `## X.Y.Z` section becomes the notes of the matching GitHub release.

## Unreleased

- Styling through documented CSS custom properties (`--fe-batch-*`): colors and radii can be changed from Additional CSS; with no overrides the look is unchanged. See [Styling](https://github.com/eliseumarmon/filter-everything-batch-apply/blob/main/README.md#styling).
- Apply and Reset hover colors follow their base colors (`color-mix()`), so changing `--fe-batch-ink` or the button colors also updates the hover state.

## 0.2.0 - 2026-10-23

- **Zero configuration:** fields, URL parameters and separator come from Filter Everything for each page and filter set; a DOM fallback covers pages without configuration.
- Works on any page where Filter Everything renders supported fields (shop, categories, tags, brands); inactive elsewhere and with path permalinks.
- Labels view and any number of numeric ranges.
- Translatable strings, Spanish translation, WooCommerce currency symbol.
- Busy Apply/Reset that cannot be double-submitted; untouched full ranges add no parameters.
- Back/Forward show the state of the page you return to, with or without the back/forward cache.
- Keyboard and focus improvements (see [Accessibility](https://github.com/eliseumarmon/filter-everything-batch-apply/blob/main/README.md#accessibility)).
- Robust re-initialization when the widget is replaced, and no work on pages without a widget.
- `fe_batch_apply_fields` and `fe_batch_apply_reset_presentation` filters; requires WordPress 6.5 and declares the Filter Everything dependency.
- Automatic updates from GitHub releases (see [Updates](https://github.com/eliseumarmon/filter-everything-batch-apply/blob/main/README.md#updates)), published by a tag-triggered release workflow.

## 0.1.x

Built for a single shop: local checkbox selection with one Apply navigation, a local price editor, Reset, hidden native buttons and a sticky action panel.
