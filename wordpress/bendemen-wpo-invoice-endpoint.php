<?php
/**
 * Bendemen Supply Panel – beveiligde WP Overnight PDF-factuurroute.
 * Plaats als PHP-snippet (zonder extra PHP-tags) of in een kleine site-plugin.
 * Definieer WPO_WCPDF_API_TOKEN met exact dezelfde willekeurige token als in Supply Panel.
 */
add_action('rest_api_init', function () {
    register_rest_route('bendemen/v1', '/orders/(?P<id>\\d+)/invoice', [
        'methods' => 'GET',
        'permission_callback' => function (WP_REST_Request $request) {
            if (!defined('WPO_WCPDF_API_TOKEN') || !WPO_WCPDF_API_TOKEN) {
                return new WP_Error('invoice_not_configured', 'Invoice endpoint is not configured.', ['status' => 503]);
            }
            $provided = (string) $request->get_header('x-bendemen-invoice-token');
            return $provided !== '' && hash_equals((string) WPO_WCPDF_API_TOKEN, $provided)
                ? true
                : new WP_Error('rest_forbidden', 'Invalid invoice token.', ['status' => 403]);
        },
        'callback' => function (WP_REST_Request $request) {
            if (!function_exists('wcpdf_get_document') || !function_exists('wcpdf_get_document_file')) {
                return new WP_Error('wpo_missing', 'WP Overnight PDF Invoices is not active.', ['status' => 503]);
            }
            $order = wc_get_order(absint($request['id']));
            if (!$order) return new WP_Error('order_not_found', 'WooCommerce order not found.', ['status' => 404]);
            $document = wcpdf_get_document('invoice', $order, true);
            if (!$document || !is_object($document)) {
                return new WP_Error('invoice_unavailable', 'WP Overnight has no invoice document for this order.', ['status' => 404]);
            }
            $file = wcpdf_get_document_file($document, 'pdf');
            if (!$file || !is_readable($file)) {
                return new WP_Error('invoice_file_missing', 'WP Overnight could not render the invoice PDF.', ['status' => 404]);
            }
            $contents = file_get_contents($file);
            if ($contents === false || substr($contents, 0, 5) !== '%PDF-') {
                return new WP_Error('invalid_invoice_pdf', 'WP Overnight did not return a valid PDF.', ['status' => 502]);
            }
            $response = new WP_REST_Response($contents, 200);
            $response->header('Content-Type', 'application/pdf');
            $response->header('Content-Disposition', 'inline; filename="invoice-' . absint($order->get_id()) . '.pdf"');
            $response->header('Cache-Control', 'private, no-store');
            return $response;
        },
    ]);
});
