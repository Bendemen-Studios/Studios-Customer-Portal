# Bendemen Studios Customer Portal v1.10

Private customer panel for Bendemen Studios. Node.js 20+, Express and SQLite.

## Features
- Customer accounts created and managed by admin; no public registration.
- Customers see their own orders, invoices, recurring services and monthly costs.
- Admin account is fixed to info@bendemen.nl and uses passwordless one-time magic links.
- Magic links expire after 15 minutes and can be used once.
- SMTP uses implicit SSL/TLS on port 465 by default.
- Payment links are only exposed through the authenticated order-owner route.
- Automated reorder/recurring-order email support.
- WooCommerce integration and WP Overnight invoice bridge.
- Admin can disable customer access.

## Install
1. Copy this project to your Node.js host (Pterodactyl supported).
2. Use Node.js 20 or newer and run `npm install`.
3. Copy `.env.example` to `.env` and configure credentials and URLs.
4. Ensure `data/` is writable and persistent.
5. Run `npm start`.

## Admin login
Admin email: `info@bendemen.nl`. There is no admin password. Open `/login`, enter this address and request a magic link. The link is one-time and expires after 15 minutes.

Required SMTP variables: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_PORT=465`, `SMTP_SECURE=true`, and `PANEL_PUBLIC_URL`. Port 465 uses implicit SSL/TLS (not STARTTLS/587).

## WooCommerce and invoices
Configure `WC_STORE_URL`, `WC_CONSUMER_KEY` and `WC_CONSUMER_SECRET`. Install the provided WooCommerce status snippet and the WP Overnight invoice bridge plugin in WordPress.

## Security
- Never commit `.env`, SQLite data or credentials.
- Preserve `.env` and `data/bendemen.sqlite` during upgrades.
- Set a unique `SESSION_SECRET` with at least 32 characters.
- Customer order access must remain ownership-scoped.
