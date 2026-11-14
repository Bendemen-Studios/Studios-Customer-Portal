<?php
/**
 * Plugin Name: Bendemen WP Overnight Invoice Bridge
 * Description: Generates and returns WP Overnight PDF invoices to the authenticated Bendemen Supply Panel integration.
 * Version: 1.2.0
 */

if (!defined('ABSPATH')) {
  exit;
}

define('BENDEMEN_WPO_INVOICE_BRIDGE_OPTION', 'bendemen_wpo_invoice_bridge_token');

/**
 * Generate a cryptographically secure token when no token exists yet.
 */
function bendemen_wpo_invoice_bridge_generate_token() {
  return bin2hex(random_bytes(32));
}

/**
 * Return the configured token, lazily creating one for new installations.
 */
function bendemen_wpo_invoice_bridge_get_token() {
  $token = (string) get_option(BENDEMEN_WPO_INVOICE_BRIDGE_OPTION, '');
  if ($token === '' && !defined('BENDEMEN_WPO_WCPDF_API_TOKEN')) {
    $token = bendemen_wpo_invoice_bridge_generate_token();
    add_option(BENDEMEN_WPO_INVOICE_BRIDGE_OPTION, $token, '', false);
  }
  if ($token === '' && defined('BENDEMEN_WPO_WCPDF_API_TOKEN')) {
    $token = (string) BENDEMEN_WPO_WCPDF_API_TOKEN;
  }
  return $token;
}

/**
 * Supply Panel orders must receive an invoice immediately, including while
 * WooCommerce is waiting for payment. Only orders carrying our private marker
 * are affected; all other shop orders keep the normal WP Overnight rules.
 */
add_filter('wpo_wcpdf_document_is_allowed', function ($allowed, $document) {
  if (!is_object($document) || !is_object($document->order ?? null)) {
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

/**
 * Add a dedicated settings page under WooCommerce.
 */
add_action('admin_menu', function () {
  add_submenu_page(
    'woocommerce',
    'Bendemen Invoice Bridge',
    'Invoice Bridge',
    'manage_woocommerce',
    'bendemen-invoice-bridge',
    'bendemen_wpo_invoice_bridge_render_settings'
  );
});

add_action('admin_post_bendemen_wpo_invoice_bridge_regenerate', function () {
  if (!current_user_can('manage_woocommerce')) {
    wp_die(esc_html__('You are not allowed to manage invoice bridge settings.', 'bendemen-invoice-bridge'), 403);
  }
  check_admin_referer('bendemen_wpo_invoice_bridge_regenerate');

  if (defined('BENDEMEN_WPO_WCPDF_API_TOKEN')) {
    $redirect = add_query_arg(
      array('page' => 'bendemen-invoice-bridge', 'token_managed' => 'constant'),
      admin_url('admin.php')
    );
    wp_safe_redirect($redirect);
    exit;
  }

  $token = bendemen_wpo_invoice_bridge_generate_token();
  update_option(BENDEMEN_WPO_INVOICE_BRIDGE_OPTION, $token, false);

  $redirect = add_query_arg(
    array('page' => 'bendemen-invoice-bridge', 'token_regenerated' => '1'),
    admin_url('admin.php')
  );
  wp_safe_redirect($redirect);
  exit;
});

function bendemen_wpo_invoice_bridge_render_settings() {
  if (!current_user_can('manage_woocommerce')) {
    return;
  }

  $token = bendemen_wpo_invoice_bridge_get_token();
  $constant_managed = defined('BENDEMEN_WPO_WCPDF_API_TOKEN');
  ?>
  <div class="wrap">
    <h1>Bendemen Invoice Bridge</h1>
    <p>Gebruik deze geheime token om Supply Panel toegang te geven tot PDF-facturen van WP Overnight.</p>
    <?php if (isset($_GET['token_regenerated'])) : ?>
      <div class="notice notice-success is-dismissible"><p>Er is een nieuwe Invoice Bridge-token gegenereerd. Werk ook <code>WPO_WCPDF_API_TOKEN</code> in Supply Panel bij.</p></div>
    <?php endif; ?>
    <?php if (isset($_GET['token_managed']) && $constant_managed) : ?>
      <div class="notice notice-warning"><p>De token wordt momenteel beheerd via de PHP-constante <code>BENDEMEN_WPO_WCPDF_API_TOKEN</code>. Pas die constante aan in plaats van de token hier te wijzigen.</p></div>
    <?php endif; ?>

    <table class="form-table" role="presentation">
      <tr>
        <th scope="row"><label for="bendemen-wpo-invoice-token">Invoice Token</label></th>
        <td>
          <input
            type="password"
            id="bendemen-wpo-invoice-token"
            class="regular-text"
            value="<?php echo esc_attr($token); ?>"
            autocomplete="new-password"
            readonly
          />
          <button type="button" class="button" id="bendemen-wpo-toggle-token">Tonen</button>
          <button type="button" class="button" id="bendemen-wpo-copy-token">Kopiëren</button>
          <p class="description">Bewaar deze token veilig. Iedereen met deze token kan via de beveiligde bridge factuur-PDF's opvragen.</p>
        </td>
      </tr>
    </table>

    <?php if (!$constant_managed) : ?>
      <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" onsubmit="return confirm('Weet je zeker dat je de Invoice Token wilt vervangen? Supply Panel werkt pas weer zodra je daar dezelfde nieuwe token hebt ingesteld.');">
        <input type="hidden" name="action" value="bendemen_wpo_invoice_bridge_regenerate" />
        <?php wp_nonce_field('bendemen_wpo_invoice_bridge_regenerate'); ?>
        <?php submit_button('Nieuwe token genereren', 'secondary'); ?>
      </form>
    <?php endif; ?>

    <hr />
    <h2>Supply Panel configuratie</h2>
    <p>Voeg de token toe aan de environment variables van Supply Panel:</p>
    <p><code>WPO_WCPDF_API_TOKEN= jouw_token</code></p>
    <p>De API-route is <code>/wp-json/bendemen/v1/orders/{order_id}/invoice</code>.</p>
  </div>
  <script>
  (function () {
    const field = document.getElementById('bendemen-wpo-invoice-token');
    const toggle = document.getElementById('bendemen-wpo-toggle-token');
    const copy = document.getElementById('bendemen-wpo-copy-token');
    if (!field || !toggle || !copy) return;

    toggle.addEventListener('click', function () {
      const visible = field.type === 'text';
      field.type = visible ? 'password' : 'text';
      toggle.textContent = visible ? 'Tonen' : 'Verbergen';
    });

    copy.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(field.value);
        copy.textContent = 'Gekopieerd!';
      } catch (error) {
        field.type = 'text';
        field.focus();
        field.select();
        document.execCommand('copy');
        copy.textContent = 'Gekopieerd!';
      }
      window.setTimeout(function () { copy.textContent = 'Kopiëren'; }, 1800);
    });
  }());
  </script>
  <?php
}

add_action('rest_api_init', function () {
  register_rest_route('bendemen/v1', '/orders/(?P<order_id>\\d+)/invoice', array(
    'methods' => 'GET',
    'callback' => function ($request) {
      if (!function_exists('wcpdf_get_document') || !function_exists('wcpdf_get_document_file')) {
        return new WP_Error('wpo_unavailable', 'WP Overnight PDF Invoices is not active or supported.', array('status' => 503));
      }

      $expected = bendemen_wpo_invoice_bridge_get_token();
      $provided = (string) $request->get_header('x-bendemen-invoice-token');
      if ($expected === '' || $provided === '' || !hash_equals($expected, $provided)) {
        return new WP_Error('forbidden', 'Invalid invoice API token.', array('status' => 403));
      }

      $order = wc_get_order((int) $request['order_id']);
      if (!$order) {
        return new WP_Error('not_found', 'WooCommerce order not found.', array('status' => 404));
      }

      try {
        // Mark the existing order as a Supply Panel order too. This also repairs
        // orders created before the invoice bridge metadata was added.
        if ((string) $order->get_meta('_bendemen_supply_panel_order') !== '1') {
          $order->update_meta_data('_bendemen_supply_panel_order', '1');
          $order->save();
        }

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
