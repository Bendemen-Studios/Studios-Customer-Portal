<?php
/**
 * Plugin Name: Bendemen Supply Password Sync
 * Description: Secure password synchronization between Bendemen Supply Panel and WordPress customer accounts.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) { exit; }

add_action('rest_api_init', function () {
    register_rest_route('bendemen/v1', '/customer-password', [
        'methods' => 'POST',
        'callback' => 'bendemen_supply_set_customer_password',
        'permission_callback' => '__return_true',
    ]);
});

function bendemen_supply_set_customer_password(WP_REST_Request $request) {
    $configured_token = defined('BENDEMEN_SUPPLY_SYNC_TOKEN') ? (string) BENDEMEN_SUPPLY_SYNC_TOKEN : '';
    $provided_token = (string) $request->get_header('x-bendemen-sync-token');
    if ($configured_token === '' || $provided_token === '' || !hash_equals($configured_token, $provided_token)) {
        return new WP_Error('forbidden', 'Invalid sync token.', ['status' => 403]);
    }
    $customer_id = absint($request->get_param('customer_id'));
    $password = (string) $request->get_param('password');
    if (!$customer_id || strlen($password) < 6 || strlen($password) > 200) {
        return new WP_Error('invalid_request', 'A valid customer and password of at least 6 characters are required.', ['status' => 400]);
    }
    $user = get_user_by('id', $customer_id);
    if (!$user || (!in_array('customer', (array) $user->roles, true) && !in_array('subscriber', (array) $user->roles, true))) {
        return new WP_Error('invalid_customer', 'Customer account not found.', ['status' => 404]);
    }
    wp_set_password($password, $customer_id);
    return new WP_REST_Response(['success' => true], 200);
}
