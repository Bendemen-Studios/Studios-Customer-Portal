<?php
/**
 * Plugin Name: Bendemen WP Overnight Invoice Bridge
 * Description: Exposes final WP Overnight PDF invoices to the authenticated customer portal integration.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) exit;
add_action('rest_api_init', function () {
  register_rest_route('bendemen/v1', '/invoice/(?P<order_id>\d+)', array(
    'methods' => 'GET',
    'callback' => function ($request) {
      $order = wc_get_order((int) $request['order_id']);
      if (!$order) return new WP_Error('not_found', 'Order not found', array('status' => 404));
      $url = '';
      if (function_exists('wcpdf_get_document')) {
        $document = wcpdf_get_document('invoice', $order, true);
        if ($document) $url = $document->get_pdf_url();
      }
      return rest_ensure_response(array('order_id' => $order->get_id(), 'invoice_url' => $url));
    },
    'permission_callback' => function () { return current_user_can('manage_woocommerce'); }
  ));
});
