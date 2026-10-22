<?php
/**
 * Plugin Name: Filter Everything Batch Apply (Prototype)
 * Description: Allows selecting WooCommerce filters locally and applying them in one request, using Filter Everything's existing URL parameters.
 * Version: 0.1.4
 * Requires PHP: 7.4
 * Author: Eliseu Martínez
 * License: GPL-2.0-or-later
 * Text Domain: fe-batch-apply
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Only run on WooCommerce product archive views, never in wp-admin.
 */
function fe_batch_is_archive() {
    return function_exists('is_shop') && (
        is_shop() || is_product_category() || is_product_tag() || is_post_type_archive('product')
    );
}

/**
 * Run before Filter Everything's JavaScript restores the visitor's old
 * folding/more-less preferences. Only presentation cookies are cleared.
 * This does not touch the actual filter query or WooCommerce session.
 */
add_action('wp_head', function () {
    if (!fe_batch_is_archive()) {
        return;
    }
    echo '<script id="fe-batch-reset-presentation">(function(){["wpcContainersStatus","wpcMoreLessStatus"].forEach(function(name){document.cookie=name+"=; Max-Age=0; Path=/; SameSite=Lax";});})();</script>' . "\n";
}, -100);

add_action('wp_enqueue_scripts', function () {
    if (!fe_batch_is_archive()) {
        return;
    }

    $url = plugin_dir_url(__FILE__);
    wp_enqueue_style('fe-batch-apply', $url . 'assets/batch-apply.css', array(), '0.1.4');
    wp_enqueue_script('fe-batch-apply', $url . 'assets/batch-apply.js', array(), '0.1.4', true);
}, 99);
