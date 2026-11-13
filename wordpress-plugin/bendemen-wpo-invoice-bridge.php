<?php
/**
 * Plugin Name: Bendemen WP Overnight Invoice Bridge
 * Description: Generates and returns WP Overnight PDF invoices to the authenticated Bendemen Supply Panel integration.
 * Version: 1.1.0
 */
if (!defined('ABSPATH')) exit;

/**
 * Supply Panel orders must receive an invoice immediately, including while
 * WooCommerce is waiting for payment. Only orders carrying our private marker
 * are affected; all other shop orders keep the normal WP Overnight rules.
 */
add_filter('wpo_wcpdf_document_is_allowed', function ($allowed, $document) {
  if (!is_object($document) || !isset($document->order) || !is_object($document->order)) {
    return $allowed;
  }
  if (method_exists($document, 'get_type') && $document->get_type() === 'invoice') {
    $order = $document->order;
    if ((string) $order->get_meta('_bendemen_supply_panel_order') === '1') {
      return true;
    }
  }
  return $allowed;
}, 20, 2);

add_action('rest_api_init', function () {
  register_rest_route('bendemen/v1', '/orders/(?P<order_id>\\d+)/invoice', array(
    'methods' => 'GET',
    'callback' => function ($request) {
      if (!function_exists('wcpdf_get_document') || !function_exists('wcpdf_get_document_file')) {
        return new WP_Error('wpo_unavailable', 'WP Overnight PDF Invoices is not active or supported.', array('status' => 503));
      }

      $expected = defined('BENDEMEN_WPO_WCPDF_API_TOKEN') ? (string) BENDEMEN_WPO_WCPDF_API_TOKEN : '';
      $provided = (string) $request->get_header('x-bendemen-invoice-token');
      if ($expected === '' || $provided === '' || !hash_equals($expected, $provided)) {
        return new WP_Error('forbidden', 'Invalid invoice API token.', array('status' => 403));
      }

      $order = wc_get_order((int) $request['order_id']);
      if (!$order) return new WP_Error('not_found', 'WooCommerce order not found.', array('status' => 404));

      try {
        // init=true creates and saves the invoice number/document if it does not exist yet.
        $document = wcpdf_get_document('invoice', $order, true);
        if (!$document) {
          return new WP_Error('invoice_not_allowed', 'WP Overnight does not allow an invoice for this order status. Check the invoice status settings.', array('status' => 409));
        }
        $file = wcpdf_get_document_file($document, 'pdf');
        if (!$file || !is_file($file) || !is_readable($file)) {
          return new WP_Error('invoice_generation_failed', 'WP Overnight could not generate the invoice PDF.', array('status' => 502));
        }
        $pdf = file_get_contents($file);
        if (!is_string($pdf) || substr($pdf, 0, 5) !== '%PDF-') {
          return new WP_Error('invalid_pdf', 'WP Overnight returned an invalid PDF.', array('status' => 502));
        }
        return rest_ensure_response(array(
          'order_id' => $order->get_id(),
          'invoice_number' => method_exists($document, 'get_number') ? $document->get_number() : '',
          'pdf_base64' => base64_encode($pdf),
        ));
      } catch (Throwable $error) {
        error_log('Bendemen invoice bridge: ' . $error->getMessage());
        return new WP_Error('invoice_generation_failed', 'Invoice generation failed: ' . $error->getMessage(), array('status' => 502));
      }
    },
    'permission_callback' => '__return_true'
  ));
});
