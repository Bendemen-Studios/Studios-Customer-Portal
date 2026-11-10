<?php
/**
 * Plugin Name: Bendemen Order Started Status
 * Description: Adds the custom WooCommerce order status "Order gestart".
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) exit;
add_action('init', function () {
  register_post_status('wc-order-started', array(
    'label' => 'Order gestart',
    'public' => true,
    'show_in_admin_status_list' => true,
    'show_in_admin_all_list' => true,
    'label_count' => _n_noop('Order gestart (%s)', 'Order gestart (%s)')
  ));
});
add_filter('wc_order_statuses', function ($statuses) {
  $statuses['wc-order-started'] = 'Order gestart';
  return $statuses;
});
