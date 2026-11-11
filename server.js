const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const envPath = path.join(__dirname, ".env");
require("dotenv").config({ path: envPath });

// Genereer en bewaar automatisch een sessiesleutel als .env ontbreekt
// of SESSION_SECRET niet minimaal 32 tekens bevat.
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  const generatedSecret = crypto.randomBytes(48).toString("hex");
  let envText = "";
  try { envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : ""; } catch (_) {}
  const secretLine = "SESSION_SECRET=" + generatedSecret;
  if (/^SESSION_SECRET=.*$/m.test(envText)) {
    envText = envText.replace(/^SESSION_SECRET=.*$/m, secretLine);
  } else {
    envText = envText.replace(/\s*$/, "") + (envText.trim() ? "\n" : "") + secretLine + "\n";
  }
  fs.writeFileSync(envPath, envText, { mode: 0o600 });
  process.env.SESSION_SECRET = generatedSecret;
  console.warn("SESSION_SECRET ontbrak of was te kort; automatisch een veilige sleutel aangemaakt in .env.");
}
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const db = require("./src/db");
const { requireAuth, requireAdmin } = require("./src/auth");
const woo = require("./src/woocommerce");
const { sendAutomatedOrderEmail } = require("./src/order-mail");

const app = express();
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(express.json({ limit: "32kb" }));
app.use(session({
  name: "bendemen.sid", secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const euro = cents => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format((cents || 0) / 100);
const money = euro;
function page(req, title, body) {
  const user = req.session.user;
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Bendemen Studios</title><link rel="stylesheet" href="/style.css"></head><body>
  <header class="top"><a class="brand" href="/"><img class="brand-logo" src="/bendemen-logo.png" alt="Bendemen Studios"></a>${user ? `<nav><a href="/">Dashboard</a><a href="/orders">Bestellingen</a><a href="/costs">Maandkosten</a><a href="/subscriptions">Diensten</a>${user.role === "admin" ? '<a href="/admin">Beheer</a>' : ''}</nav><div class="account"><span>${esc(user.name)}</span><form method="post" action="/logout"><button class="linkbtn">Uitloggen</button></form></div>` : '<a class="mutedlink" href="/login">Inloggen</a>'}</header>
  <main class="wrap">${body}</main><footer>© ${new Date().getFullYear()} Bendemen Studios <span>Customer portal</span></footer></body></html>`;
}
function moneyInput(value) { return Math.round(Number(String(value).replace(",", ".")) * 100); }
function orderItems(orderId) { return db.prepare("SELECT product_name,quantity,unit_price_cents FROM order_items WHERE order_id=?").all(orderId); }
function displayOrderStatus(o) {
  if (o.workflow_status === "cancelled" || o.wc_status === "cancelled") return "Geannuleerd";
  if (["processing","completed"].includes(o.wc_status)) return "In behandeling";
  if (o.wc_status === "order-started" || o.workflow_status === "started") return "Order gestart";
  return o.wc_status || o.status;
}
function orderCard(o) {
  const payment = o.payment_url && !["processing","completed","refunded","cancelled"].includes(o.wc_status) ? `<a class="textlink" href="/orders/${o.id}/pay">Betalen →</a>` : "";
  return `<div class="order-row"><div><strong>${esc(o.order_number)}</strong><small>${esc(o.date)}</small></div><div class="order-products">${esc(o.summary || "Geen orderregels")}</div><div><span class="status">${esc(displayOrderStatus(o))}</span></div><strong>${money(o.total_cents)}</strong><div class="row-actions"><a class="textlink" href="/orders/${o.id}">Bekijken →</a>${payment}</div></div>`;
}
function getOrders(userId, limit = 100) {
  return db.prepare(`SELECT o.*, 'BDS-' || printf('%06d',o.id) order_number,
    strftime('%d-%m-%Y',o.created_at) date,
    (SELECT group_concat(oi.quantity || '× ' || oi.product_name, ', ') FROM order_items oi WHERE oi.order_id=o.id) summary
    FROM orders o WHERE o.user_id=? ORDER BY o.id DESC LIMIT ?`).all(userId, limit);
}
async function syncWooOrder(orderId) {
  try { const result = await woo.createWooOrder(orderId); if (result?.payment_url) console.log(`WooCommerce order ${result.id} aangemaakt voor lokale order ${orderId}`); return result; }
  catch (err) { console.error(`WooCommerce order sync mislukt voor lokale order ${orderId}:`, err.message); return null; }
}
async function sendOrderWebhook(orderId) {
  const url = process.env.ORDER_WEBHOOK_URL; if (!url) return;
  const o = db.prepare(`SELECT o.*,u.name customer_name,u.email customer_email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?`).get(orderId);
  const items = orderItems(orderId).map(i => ({ productName: i.product_name, quantity: i.quantity, unitPriceCents: i.unit_price_cents }));
  const payload = { event:"order.created", order:{id:o.id,orderNumber:`BDS-${String(o.id).padStart(6,"0")}`,customer:{id:o.user_id,name:o.customer_name,email:o.customer_email},items,totalCents:o.total_cents,currency:o.currency,status:o.status,createdAt:o.created_at} };
  try { const headers={"content-type":"application/json"}; if(process.env.ORDER_WEBHOOK_TOKEN) headers.authorization=`Bearer ${process.env.ORDER_WEBHOOK_TOKEN}`; const response=await fetch(url,{method:"POST",headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)}); if(!response.ok) console.error(`Order webhook HTTP ${response.status}`); }
  catch(err){console.error("Order webhook failed:",err.message);}
}
function createOrder(userId, lines, sourceOrderId=null, notes="", recurringOrderId=null) {
  if(!Array.isArray(lines)||!lines.length) throw new Error("Deze bestelling bevat geen producten.");
  const total=lines.reduce((sum,x)=>sum+x.quantity*x.unit_price_cents,0);
  const tx=db.transaction(()=>{
    const order=db.prepare("INSERT INTO orders (user_id,status,total_cents,source_order_id,notes,recurring_order_id) VALUES (?,'Nieuw',?,?,?,?)").run(userId,total,sourceOrderId,notes,recurringOrderId);
    const insert=db.prepare("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price_cents) VALUES (?,?,?,?,?)");
    for(const x of lines) insert.run(order.lastInsertRowid,x.product_id||null,x.product_name,x.quantity,x.unit_price_cents);
    return Number(order.lastInsertRowid);
  });
  return tx();
}

app.get("/login",(req,res)=>{
  if(req.session.user)return res.redirect("/");
  const error=req.query.error?'<div class="alert">Inloggen is niet gelukt. Controleer je e-mailadres en wachtwoord.</div>':"";
  res.send(page(req,"Inloggen",`<section class="auth-card"><div class="eyebrow">BENDEMEN STUDIOS</div><h1>Welkom terug.</h1><p class="sub">Log in met je e-mailadres en wachtwoord om je account te beheren.</p>${req.query.disabled?'<div class="alert">Dit account is uitgeschakeld. Neem contact op met Bendemen Studios.</div>':""}${error}<form method="post" action="/login" class="stack"><label>E-mailadres<input name="email" type="email" autocomplete="username" required></label><label>Wachtwoord<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Inloggen <span>→</span></button></form></section>`));
});
app.post("/login",loginLimiter,async(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  const user=db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(email);
  if(!user||user.active!==1||!["admin","customer"].includes(user.role)||!(await bcrypt.compare(password,user.password_hash)))return res.redirect("/login?error=1");
  req.session.regenerate(err=>{if(err)return res.status(500).send("Sessie kon niet worden gestart.");req.session.user={id:user.id,name:user.name,email:user.email,role:user.role};res.redirect(user.role==="admin"?"/admin":"/");});
});
app.post("/logout",requireAuth,(req,res)=>req.session.destroy(()=>res.redirect("/login")));

app.get("/",requireAuth,(req,res)=>{
  const user=req.session.user,orders=getOrders(user.id,5);
  const monthly=db.prepare("SELECT COALESCE(SUM(amount_cents),0) total FROM monthly_costs WHERE user_id=? AND active=1").get(user.id).total;
  const orderSpend=db.prepare("SELECT COALESCE(SUM(total_cents),0) total FROM orders WHERE user_id=? AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get(user.id).total;
  const body=`<div class="hero"><div><div class="eyebrow">CUSTOMER PORTAL</div><h1>Goedendag, ${esc(user.name.split(" ")[0])}.</h1><p>Alles rondom jouw 3D-printbestellingen op één plek.</p></div><a class="primary inline" href="/orders">Mijn bestellingen <span>→</span></a></div>
  <div class="stats"><article class="stat"><span>Vaste maandkosten</span><strong>${money(monthly)}</strong><small>Actieve maandelijkse kosten</small></article><article class="stat"><span>Besteld deze maand</span><strong>${money(orderSpend)}</strong><small>Nieuwe orders deze maand</small></article><article class="stat"><span>Totaal bestellingen</span><strong>${db.prepare("SELECT COUNT(*) n FROM orders WHERE user_id=?").get(user.id).n}</strong><small>Alle geregistreerde orders</small></article></div>
  <section class="section-head"><div><div class="eyebrow">RECENT</div><h2>Recente bestellingen</h2></div><a class="textlink" href="/orders">Alle bestellingen →</a></section><div class="panel">${orders.length?orders.map(orderCard).join(""):'<div class="empty">Je hebt nog geen bestellingen.</div>'}</div>
  <div class="bottom-cta"><div><strong>Hetzelfde product nog een keer nodig?</strong><p>Bestel opnieuw vanuit je bestelgeschiedenis.</p></div><a class="secondary" href="/orders">Bekijk historie</a></div>`;
  res.send(page(req,"Dashboard",body));
});
app.get("/orders",requireAuth,(req,res)=>{const orders=getOrders(req.session.user.id);res.send(page(req,"Bestellingen",`<div class="page-title"><div class="eyebrow">JOUW OVERZICHT</div><h1>Bestellingen</h1><p>Bekijk je eerdere 3D-printorders en bestel ze eenvoudig opnieuw.</p></div><div class="panel">${orders.length?orders.map(orderCard).join(""):'<div class="empty">Nog geen bestellingen gevonden.</div>'}</div>`));});
app.get("/orders/:id",requireAuth,async(req,res)=>{
  const id=Number(req.params.id),o=db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(id,req.session.user.id);
  if(!o)return res.status(404).send(page(req,"Niet gevonden","<h1>Bestelling niet gevonden</h1>"));
  try{await woo.refreshWooOrder(id);}catch(e){console.error("Woo status refresh:",e.message);}
  const fresh=db.prepare("SELECT * FROM orders WHERE id=?").get(id),items=orderItems(id);
  const rows=items.map(i=>`<tr><td>${esc(i.product_name)}</td><td>${i.quantity}</td><td>${money(i.unit_price_cents)}</td><td>${money(i.quantity*i.unit_price_cents)}</td></tr>`).join("");
  const canCancel=fresh.workflow_status==="started"&&!["processing","completed","cancelled","refunded"].includes(fresh.wc_status);
  const payBlock=fresh.payment_url&&!["processing","completed","refunded","cancelled"].includes(fresh.wc_status)?`<div class="payment-box"><div><strong>Deze bestelling staat nog open</strong><p>Betaal veilig via de betaalpagina van Bendemen Studios.</p></div><a class="primary" href="/orders/${id}/pay">Nu betalen <span>→</span></a></div>`:(fresh.wc_status?`<p class="hint">WooCommerce-status: ${esc(displayOrderStatus(fresh))}</p>`:'<p class="hint">De WooCommerce-betaallink verschijnt zodra de winkelkoppeling is ingesteld.</p>');
  const cancelBlock=canCancel?`<form method="post" action="/orders/${id}/cancel" class="cancel-box"><div><strong>Bestelling annuleren</strong><p>Dit kan zolang de bestelling nog niet in behandeling is genomen.</p></div><button class="danger">Bestelling annuleren</button></form>`:"";
  const invoiceBlock=fresh.wc_order_id&&["processing","completed","refunded"].includes(fresh.wc_status)?`<p class="invoice-action"><a class="secondary" href="/orders/${id}/invoice" target="_blank" rel="noopener">Factuur downloaden (PDF) →</a></p>`:"";
  res.send(page(req,"Bestelling",`<a class="back" href="/orders">← Terug naar bestellingen</a><div class="page-title"><div class="eyebrow">BESTELLING BDS-${String(id).padStart(6,"0")}${fresh.wc_order_id?` · WC #${fresh.wc_order_id}`:""}</div><h1>Bestelling bekijken</h1><p>Aangemaakt op ${esc(o.created_at)} · <span class="status">${esc(displayOrderStatus(fresh))}</span></p></div>${payBlock}${cancelBlock}${invoiceBlock}<div class="panel"><div class="table-wrap"><table><thead><tr><th>Product</th><th>Aantal</th><th>Prijs per stuk</th><th>Totaal</th></tr></thead><tbody>${rows}</tbody></table></div><div class="total-line"><span>Ordertotaal</span><strong>${money(o.total_cents)}</strong></div></div><form method="post" action="/orders/${id}/reorder" class="reorder-form"><div><strong>Dit product opnieuw bestellen?</strong><p>We maken direct een nieuwe order aan met dezelfde producten en aantallen.</p></div><button class="primary">Opnieuw bestellen <span>→</span></button></form>`));
});
app.get("/orders/:id/pay",requireAuth,(req,res)=>{
  const id=Number(req.params.id),order=db.prepare("SELECT id,payment_url,wc_status,workflow_status FROM orders WHERE id=? AND user_id=?").get(id,req.session.user.id);
  if(!order)return res.status(404).send("Bestelling niet gevonden.");
  if(!order.payment_url||["processing","completed","refunded","cancelled"].includes(order.wc_status)||order.workflow_status==="cancelled")return res.status(409).send("Voor deze bestelling is geen betaling (meer) nodig.");
  res.redirect(order.payment_url);
});
app.get("/orders/:id/invoice",requireAuth,async(req,res)=>{
  const id=Number(req.params.id),order=db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(id,req.session.user.id);
  if(!order||!order.wc_order_id)return res.status(404).send("Factuur niet gevonden.");
  if(!["processing","completed","refunded"].includes(order.wc_status))return res.status(409).send("De factuur is nog niet beschikbaar.");
  try{const invoice=await woo.getInvoice(order.wc_order_id);if(!invoice?.invoice_url)return res.status(404).send("WP Overnight heeft nog geen PDF-factuur beschikbaar.");res.redirect(invoice.invoice_url);}catch(err){console.error(err);res.status(502).send("Factuur kon niet worden opgehaald.");}
});
app.post("/orders/:id/reorder",requireAuth,async(req,res)=>{
  const id=Number(req.params.id),order=db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(id,req.session.user.id);
  if(!order)return res.status(404).send("Bestelling niet gevonden.");
  const lines=orderItems(id).map(x=>({product_name:x.product_name,quantity:x.quantity,unit_price_cents:x.unit_price_cents}));
  try{const newId=createOrder(req.session.user.id,lines,id,"Herbestelling");await syncWooOrder(newId);await sendOrderWebhook(newId);res.redirect(`/orders/${newId}`);}catch(err){console.error(err);res.status(500).send("Herbestelling maken is mislukt.");}
});
app.post("/orders/:id/cancel",requireAuth,(req,res)=>{
  const id=Number(req.params.id),order=db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(id,req.session.user.id);
  if(!order)return res.status(404).send("Bestelling niet gevonden.");
  if(order.workflow_status!=="started"||["processing","completed","cancelled","refunded"].includes(order.wc_status))return res.status(409).send("Deze bestelling kan niet meer worden geannuleerd.");
  db.prepare("UPDATE orders SET workflow_status='cancellation_requested' WHERE id=? AND user_id=?").run(id,req.session.user.id);
  res.redirect(`/orders/${id}`);
});

app.get("/admin",requireAuth,requireAdmin,(req,res)=>{
  const customers=db.prepare("SELECT id,name,email,active,created_at FROM users WHERE role='customer' ORDER BY name").all();
  const body=`<div class="page-title"><div class="eyebrow">BEHEER</div><h1>Klanten</h1><p>Beheer klanttoegang en bekijk de klantenlijst.</p></div><div class="panel"><table><thead><tr><th>Naam</th><th>E-mail</th><th>Toegang</th><th>Actie</th></tr></thead><tbody>${customers.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${c.active?"Actief":"Uitgeschakeld"}</td><td><form method="post" action="/admin/customers/${c.id}/access"><button class="secondary">${c.active?"Uitschakelen":"Activeren"}</button></form></td></tr>`).join("")}</tbody></table></div>`;
  res.send(page(req,"Beheer",body));
});
app.post("/admin/customers/:id/access",requireAuth,requireAdmin,(req,res)=>{
  const id=Number(req.params.id),customer=db.prepare("SELECT id FROM users WHERE id=? AND role='customer'").get(id);
  if(!customer)return res.status(404).send("Klant niet gevonden.");
  db.prepare("UPDATE users SET active=CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id=? AND role='customer'").run(id);
  res.redirect("/admin");
});
app.get("/admin/customers/:id",requireAuth,requireAdmin,(req,res)=>{
  const id=Number(req.params.id),customer=db.prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(id);
  if(!customer)return res.status(404).send("Klant niet gevonden.");
  const orders=getOrders(id);
  res.send(page(req,"Klant",`<h1>${esc(customer.name)}</h1><p>${esc(customer.email)}</p><div class="panel">${orders.map(orderCard).join("")}</div>`));
});

app.get("/health",(_req,res)=>res.json({ok:true}));
app.use((err,req,res,next)=>{console.error(err);res.status(500).send("Er is iets misgegaan.");});
app.listen(PORT, "0.0.0.0", ()=>console.log(`Bendemen Customer Portal draait op poort ${PORT}`));
