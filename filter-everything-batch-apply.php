<?php
/**
 * Plugin Name: Filter Everything Batch Apply
 * Description: Lets shoppers select Filter Everything filters locally and apply them all in one request, using Filter Everything's own URL parameters.
 * Version: 0.2.0
 * Requires at least: 6.5
 * Requires PHP: 7.4
 * Requires Plugins: filter-everything
 * Author: Eliseu Martínez
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: fe-batch-apply
 * Domain Path: /languages
 */

if (!defined('ABSPATH')) {
    exit;
}

define('FE_BATCH_APPLY_VERSION', '0.2.0');

add_action('init', function () {
    load_plugin_textdomain('fe-batch-apply', false, dirname(plugin_basename(__FILE__)) . '/languages');
});

/**
 * Map one Filter Everything field to the addon's field config.
 * Returns null for views the addon leaves to Filter Everything (radio,
 * dropdown, rating, date, range list, search, ...).
 *
 * @param mixed $filter Field array as returned by flrt_get_page_related_filters().
 * @return array|null
 */
function fe_batch_normalize_field($filter) {
    if (!is_array($filter)) {
        return null;
    }
    $slug = isset($filter['slug']) && is_scalar($filter['slug']) ? (string) $filter['slug'] : '';
    $e_name = isset($filter['e_name']) && is_scalar($filter['e_name']) ? (string) $filter['e_name'] : '';
    $entity = isset($filter['entity']) && is_scalar($filter['entity']) ? (string) $filter['entity'] : '';
    $view = isset($filter['view']) && is_scalar($filter['view']) ? (string) $filter['view'] : '';
    if ($slug === '' || $e_name === '') {
        return null;
    }

    if (in_array($view, array('checkboxes', 'labels'), true)) {
        // Multi-value field: one URL param named after the field slug.
        $params = array($slug);
    } elseif (
        in_array($entity, array('post_meta_num', 'tax_numeric'), true) &&
        $view === 'range' &&
        (empty($filter['show_range_list']) || $filter['show_range_list'] !== 'yes')
    ) {
        // Numeric range: Filter Everything uses min_{slug} / max_{slug}.
        $params = array('min_' . $slug, 'max_' . $slug);
    } else {
        return null;
    }

    return array(
        'eName' => $e_name,
        'entity' => $entity,
        'view' => $view,
        'params' => $params,
    );
}

/**
 * Supported fields of the Filter Everything sets related to the current page.
 * Empty when Filter Everything is missing, its API changed, path permalinks
 * (PRO) are on, or the page has no field the addon can handle.
 *
 * @return array
 */
function fe_batch_get_fields() {
    static $fields = null;
    if ($fields !== null) {
        return $fields;
    }
    // The related filters are only known once the main query is parsed.
    if (is_admin() || !did_action('pre_get_posts')) {
        return array();
    }

    $fields = array();
    if (!function_exists('flrt_get_page_related_filters')) {
        return $fields;
    }
    // Path permalinks encode filters in the URL path; this addon only
    // writes query-string parameters, so it stays out of the way.
    if (defined('FLRT_PERMALINKS_ENABLED') && FLRT_PERMALINKS_ENABLED) {
        return $fields;
    }

    try {
        $related = flrt_get_page_related_filters();
    } catch (\Throwable $error) {
        $related = array();
    }

    if (is_array($related)) {
        $seen = array();
        foreach ($related as $filter) {
            $field = fe_batch_normalize_field($filter);
            if ($field === null || isset($seen[$field['eName']])) {
                continue;
            }
            $seen[$field['eName']] = true;
            $fields[] = $field;
        }
    }

    /**
     * Filters the fields handled by the addon on the current page.
     * Return an empty array to keep Filter Everything's native behavior.
     *
     * @param array $fields List of { eName, entity, view, params }.
     */
    $fields = apply_filters('fe_batch_apply_fields', $fields);
    $fields = is_array($fields) ? array_values($fields) : array();
    return $fields;
}

/**
 * Whether the addon runs on the current request.
 */
function fe_batch_is_active() {
    return !empty(fe_batch_get_fields());
}

/**
 * Whether filter sections start open and More/Less starts collapsed.
 */
function fe_batch_reset_presentation_enabled() {
    return (bool) apply_filters('fe_batch_apply_reset_presentation', true);
}

/**
 * Translatable UI strings passed to the script.
 *
 * @return array
 */
function fe_batch_get_strings() {
    return array(
        'apply' => __('Apply filters', 'fe-batch-apply'),
        'reset' => __('Reset', 'fe-batch-apply'),
        /* translators: Apply button label while the filtered page is loading. */
        'busy' => __('Applying…', 'fe-batch-apply'),
        /* translators: Lower bound label of a range editor. Prices append the currency symbol, e.g. "From (€)". */
        'from' => __('From', 'fe-batch-apply'),
        /* translators: Upper bound label of a range editor. Prices append the currency symbol, e.g. "To (€)". */
        'to' => __('To', 'fe-batch-apply'),
        'minPrice' => __('Minimum price', 'fe-batch-apply'),
        'maxPrice' => __('Maximum price', 'fe-batch-apply'),
        'minValue' => __('Minimum', 'fe-batch-apply'),
        'maxValue' => __('Maximum', 'fe-batch-apply'),
    );
}

/**
 * Run before Filter Everything's JavaScript restores the visitor's old
 * folding/more-less preferences. Only presentation cookies are cleared.
 * This does not touch the actual filter query or WooCommerce session.
 */
add_action('wp_head', function () {
    if (!fe_batch_is_active() || !fe_batch_reset_presentation_enabled()) {
        return;
    }
    wp_print_inline_script_tag(
        '(function(){["wpcContainersStatus","wpcMoreLessStatus"].forEach(function(name){document.cookie=name+"=; Max-Age=0; Path=/; SameSite=Lax";});})();',
        array('id' => 'fe-batch-reset-presentation')
    );
}, -100);

add_action('wp_enqueue_scripts', function () {
    $fields = fe_batch_get_fields();
    if (empty($fields)) {
        return;
    }

    $url = plugin_dir_url(__FILE__);
    wp_enqueue_style('fe-batch-apply', $url . 'assets/batch-apply.css', array(), FE_BATCH_APPLY_VERSION);
    wp_enqueue_script('fe-batch-apply', $url . 'assets/batch-apply.js', array(), FE_BATCH_APPLY_VERSION, true);

    $config = array(
        'separator' => defined('FLRT_QUERY_TERMS_SEPARATOR') ? (string) FLRT_QUERY_TERMS_SEPARATOR : ';',
        'fields' => $fields,
        'resetPresentation' => fe_batch_reset_presentation_enabled(),
        'strings' => fe_batch_get_strings(),
        // WooCommerce returns an HTML entity (e.g. &euro;); the script uses textContent.
        'currencySymbol' => function_exists('get_woocommerce_currency_symbol')
            ? html_entity_decode((string) get_woocommerce_currency_symbol(), ENT_QUOTES, 'UTF-8')
            : '',
    );
    wp_add_inline_script(
        'fe-batch-apply',
        'window.feBatchApplyConfig = ' . wp_json_encode($config) . ';',
        'before'
    );
}, 99);
