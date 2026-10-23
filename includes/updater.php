<?php
/**
 * Automatic updates from the public GitHub releases of the plugin.
 *
 * WordPress 5.8+ asks `update_plugins_{hostname}` for plugins whose
 * `Update URI` header points to that host, then compares the returned
 * version with the installed one. This file answers for github.com with the
 * latest release: its tag is the version and its
 * `filter-everything-batch-apply.zip` asset is the package. No token is used.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('FE_BATCH_APPLY_UPDATE_ASSET', 'filter-everything-batch-apply.zip');
define('FE_BATCH_APPLY_UPDATE_TTL', 6 * HOUR_IN_SECONDS);
define('FE_BATCH_APPLY_UPDATE_RETRY_TTL', HOUR_IN_SECONDS);

/**
 * GitHub repository ("owner/repo") the releases are read from.
 *
 * @return string
 */
function fe_batch_update_repo() {
    $default = 'eliseumarmon/filter-everything-batch-apply';

    /**
     * Filters the GitHub repository used for updates, so forks can publish
     * their own releases.
     *
     * @param string $repo Repository as "owner/repo".
     */
    $repo = apply_filters('fe_batch_apply_update_repo', $default);
    if (!is_string($repo) || !preg_match('#^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$#', $repo)) {
        return $default;
    }
    return $repo;
}

/**
 * Turn a GitHub "latest release" API response into update data.
 * Returns null when the release has no usable version or package asset.
 *
 * The package must be a release download of the update repository, so a
 * tampered API response cannot point sites at another host.
 *
 * @param mixed       $release Decoded JSON of the release.
 * @param string|null $repo    owner/repo the package must come from; defaults to the update repository.
 * @return array|null { version, url, package }
 */
function fe_batch_parse_release($release, $repo = null) {
    $download_prefix = 'https://github.com/' . ($repo === null ? fe_batch_update_repo() : $repo) . '/releases/download/';
    if (!is_array($release) || empty($release['tag_name']) || !is_string($release['tag_name'])) {
        return null;
    }
    $version = preg_replace('/^v/i', '', trim($release['tag_name']));
    if (!preg_match('/^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/', $version)) {
        return null;
    }

    $package = '';
    $assets = isset($release['assets']) && is_array($release['assets']) ? $release['assets'] : array();
    foreach ($assets as $asset) {
        if (
            is_array($asset) &&
            isset($asset['name'], $asset['browser_download_url']) &&
            $asset['name'] === FE_BATCH_APPLY_UPDATE_ASSET &&
            is_string($asset['browser_download_url']) &&
            strpos($asset['browser_download_url'], $download_prefix) === 0
        ) {
            $package = $asset['browser_download_url'];
            break;
        }
    }
    if ($package === '') {
        return null;
    }

    $url = isset($release['html_url']) && is_string($release['html_url']) ? $release['html_url'] : '';
    return array(
        'version' => $version,
        'url' => $url,
        'package' => $package,
    );
}

/**
 * Latest usable release of the update repository, cached in a site transient.
 * Successful lookups are cached for 6 hours; failures (HTTP error, rate
 * limit, invalid JSON, missing asset) for 1 hour so GitHub's unauthenticated
 * limit of 60 requests per hour is never a concern.
 *
 * @return array|null { version, url, package } or null when unavailable.
 */
function fe_batch_get_latest_release() {
    $repo = fe_batch_update_repo();
    $key = 'fe_batch_apply_update_' . md5($repo);

    $cached = get_site_transient($key);
    if (is_array($cached) && array_key_exists('release', $cached)) {
        return is_array($cached['release']) ? $cached['release'] : null;
    }

    $response = wp_remote_get(
        'https://api.github.com/repos/' . $repo . '/releases/latest',
        array(
            'timeout' => 10,
            'headers' => array(
                'Accept' => 'application/vnd.github+json',
                'User-Agent' => 'filter-everything-batch-apply/' . FE_BATCH_APPLY_VERSION,
            ),
        )
    );

    $release = null;
    if (!is_wp_error($response) && (int) wp_remote_retrieve_response_code($response) === 200) {
        $release = fe_batch_parse_release(json_decode(wp_remote_retrieve_body($response), true));
    }

    set_site_transient(
        $key,
        array('release' => $release),
        $release === null ? FE_BATCH_APPLY_UPDATE_RETRY_TTL : FE_BATCH_APPLY_UPDATE_TTL
    );
    return $release;
}

/**
 * Answer WordPress's update check for this plugin only. WordPress itself
 * compares the returned version with the installed one, so a release that
 * is not newer is listed as "no update" rather than offered.
 *
 * @param array|false $update      Update data from earlier callbacks, default false.
 * @param array       $plugin_data Plugin headers.
 * @param string      $plugin_file Plugin basename.
 * @return array|false
 */
function fe_batch_filter_update($update, $plugin_data, $plugin_file) {
    if ($plugin_file !== plugin_basename(FE_BATCH_APPLY_FILE)) {
        return $update;
    }

    $release = fe_batch_get_latest_release();
    if ($release === null) {
        return $update;
    }

    return array(
        'slug' => dirname($plugin_file),
        'version' => $release['version'],
        'url' => $release['url'],
        'package' => $release['package'],
        'requires_php' => !empty($plugin_data['RequiresPHP']) ? $plugin_data['RequiresPHP'] : '7.4',
    );
}

add_filter('update_plugins_github.com', 'fe_batch_filter_update', 10, 3);

/**
 * The release ZIP always unpacks into "filter-everything-batch-apply/". When
 * the add-on is installed under another folder name (for example a GitHub
 * "Download ZIP" folder ending in "-main"), rename the unpacked folder to the
 * installed one so the update replaces it instead of deactivating the add-on.
 *
 * @param string      $source        Path of the unpacked package folder.
 * @param string      $remote_source Path of the folder the package was unpacked into.
 * @param WP_Upgrader $upgrader      Upgrader instance.
 * @param array       $hook_extra    Extra arguments; "plugin" holds the basename being updated.
 * @return string|WP_Error
 */
function fe_batch_keep_plugin_folder($source, $remote_source, $upgrader, $hook_extra = array()) {
    global $wp_filesystem;

    $basename = plugin_basename(FE_BATCH_APPLY_FILE);
    if (!is_array($hook_extra) || !isset($hook_extra['plugin']) || $hook_extra['plugin'] !== $basename) {
        return $source;
    }

    $wanted = trailingslashit($remote_source) . dirname($basename);
    if (untrailingslashit($source) === $wanted || !$wp_filesystem) {
        return $source;
    }

    return $wp_filesystem->move(untrailingslashit($source), $wanted, true) ? trailingslashit($wanted) : $source;
}

add_filter('upgrader_source_selection', 'fe_batch_keep_plugin_folder', 10, 4);
