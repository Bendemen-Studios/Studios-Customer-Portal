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
const compression = require("compression");
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
app.use(compression({ threshold: 1024, level: 6 }));
app.use(express.urlencoded({ extended: false, limit: "2mb", verify: (req,res,buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.json({ limit: "2mb", verify: (req,res,buf) => { req.rawBody = Buffer.from(buf); } }));
class SQLiteSessionStore extends session.Store {
 get(sid,callback){try{const row=db.prepare("SELECT data FROM sessions WHERE sid=? AND expires_at>?").get(sid,Date.now());callback(null,row?JSON.parse(row.data):null);}catch(err){callback(err);}}
 set(sid,sess,callback){try{const expires=sess.cookie&&sess.cookie.expires?new Date(sess.cookie.expires).getTime():Date.now()+86400000;db.prepare("INSERT INTO sessions(sid,data,expires_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at").run(sid,JSON.stringify(sess),expires);callback&&callback(null);}catch(err){callback&&callback(err);}}
 destroy(sid,callback){try{db.prepare("DELETE FROM sessions WHERE sid=?").run(sid);callback&&callback(null);}catch(err){callback&&callback(err);}}
 touch(sid,sess,callback){try{const expires=sess.cookie&&sess.cookie.expires?new Date(sess.cookie.expires).getTime():Date.now()+86400000;db.prepare("UPDATE sessions SET expires_at=? WHERE sid=?").run(expires,sid);callback&&callback(null);}catch(err){callback&&callback(err);}}
}
app.use(session({
  store: new SQLiteSessionStore(), name: "bendemen.sid", secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1h", etag: true, lastModified: true,
  setHeaders(res, filePath) {
    if (/\.(?:png|jpe?g|webp|svg|ico|woff2?)$/i.test(filePath)) res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
    else res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=300");
  }
}));
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const euro = cents => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format((cents || 0) / 100);
const money = euro;
function page(req, title, body) {
  const user = req.session.user;
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Bendemen Studios</title><link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><link rel="stylesheet" href="/style.css"></head><body>
  <header class="top"><a class="brand" href="/"><img class="brand-logo" src="/bendemen-logo.png" alt="Bendemen Studios"></a>${user ? `<nav><a href="/">Dashboard</a><a href="/orders">Bestellingen</a><a href="/services">Diensten & kosten</a><a href="/account/password">Wachtwoord</a>${user.role === "admin" ? '<a href="/admin">Beheer</a><a href="/admin/products">Producten</a><a href="/admin/subscriptions">Abonnementen</a>' : ''}</nav><div class="account"><span>${esc(user.name)}</span><form method="post" action="/logout"><button class="linkbtn">Uitloggen</button></form></div>` : '<a class="mutedlink" href="/login">Inloggen</a>'}</header>
  <main class="wrap">${body}</main><footer>© ${new Date().getFullYear()} Bendemen Studios <span>Bendemen Supply Panel</span></footer></body></html>`;
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
    FROM orders o WHERE o.user_id=? AND o.show_in_history=1 ORDER BY o.id DESC LIMIT ?`).all(userId, limit);
}
async function syncWooOrder(orderId) {
  try {
    const order=db.prepare("SELECT o.*,u.wc_customer_id,u.email customer_email,u.name customer_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?").get(orderId);
    if(!order)throw new Error("Lokale bestelling niet gevonden.");
    const items=db.prepare("SELECT * FROM order_items WHERE order_id=?").all(orderId);
    const result=await woo.createWooOrder(order,items);
    if(result?.id){
      db.prepare("UPDATE orders SET wc_order_id=?,wc_status=?,payment_url=? WHERE id=?").run(String(result.id),result.status||"pending",result.payment_url||null,orderId);
      console.log(`WooCommerce order ${result.id} aangemaakt voor lokale order ${orderId}`);
    }
    return result;
  } catch (err) { console.error(`WooCommerce order sync mislukt voor lokale order ${orderId}:`, err.message); return null; }
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



 
// Inkomende WooCommerce order.created webhook
app.post("/webhooks/woocommerce", (req,res) => {
  const secret = process.env.WC_WEBHOOK_SECRET;
  const signature = req.get("x-wc-webhook-signature") || "";
  const rawBody = req.rawBody;

  // WooCommerce sends an unsigned form-urlencoded setup ping when a webhook is saved.
  // It contains only webhook_id; acknowledge it without creating an order.
  if (!signature && req.is("application/x-www-form-urlencoded") &&
      req.body && Object.keys(req.body).length === 1 &&
      /^\d+$/.test(String(req.body.webhook_id || ""))) {
    console.info("WooCommerce webhook setup-ping bevestigd.", { webhookId: String(req.body.webhook_id) });
    return res.status(200).json({ received: true, ping: true });
  }
  // Veilige diagnose: log alleen headernamen en algemene requestmetadata, nooit headerwaarden of payload/secret.
  console.info("WooCommerce webhook ontvangen:", {
    method: req.method,
    path: req.path,
    contentType: req.get("content-type") || null,
    contentLength: req.get("content-length") || null,
    userAgent: req.get("user-agent") || null,
    host: req.get("host") || null,
    forwardedProto: req.get("x-forwarded-proto") || null,
    headerNames: Object.keys(req.headers).sort(),
    signaturePresent: !!signature,
    rawBodyPresent: !!rawBody,
    rawBodyLength: rawBody ? rawBody.length : 0,
    bodyType: Array.isArray(req.body) ? "array" : typeof req.body,
    bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body).slice(0, 30) : []
  });
  if (!secret) {
    console.error("WooCommerce webhook auth: WC_WEBHOOK_SECRET ontbreekt.");
    return res.status(503).json({ error: "WC_WEBHOOK_SECRET is niet ingesteld." });
  }
  if (!signature || !rawBody) {
    console.error("WooCommerce webhook auth: ontbrekende signature of raw body.", { signaturePresent: !!signature, rawBodyPresent: !!rawBody, contentType: req.get("content-type") || null });
    return res.status(401).json({ error: "Webhook-handtekening of ruwe request-body ontbreekt." });
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(signature.trim()), b = Buffer.from(expected);
  const validSignature = a.length === b.length && crypto.timingSafeEqual(a,b);
  if (!validSignature) {
    console.error("WooCommerce webhook auth: handtekening komt niet overeen.", { secretLength: Buffer.byteLength(secret), signatureLength: a.length, rawBodyLength: rawBody.length, contentType: req.get("content-type") || null });
    return res.status(401).json({ error: "Ongeldige WooCommerce webhook-handtekening. Controleer WC_WEBHOOK_SECRET en herstart de applicatie." });
  }
  const order = req.body;
  if (!order || !order.id) return res.status(400).json({ error: "Ongeldige WooCommerce order-payload." });
  const topic = req.get("x-wc-webhook-topic") || "";
  if (topic && topic !== "order.created") return res.status(200).json({ received: true, ignored: true, topic });
  const wcOrderId = String(order.id);
  const existing = db.prepare("SELECT id FROM orders WHERE wc_order_id=?").get(wcOrderId);
  if (existing) return res.status(200).json({ received: true, duplicate: true, localOrderId: existing.id });
  const email = String(order.billing?.email || "").trim().toLowerCase();
  const wcCustomerId = Number(order.customer_id || 0);
  const linked = wcCustomerId ? db.prepare("SELECT id FROM users WHERE wc_customer_id=? AND active=1").get(String(wcCustomerId)) : null;
  const customer = linked || (email ? db.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE AND active=1").get(email) : null);
  if (!customer) {
    console.warn("WooCommerce webhook voor niet-gekoppelde klant:", email || "(geen e-mailadres)");
    return res.status(200).json({ received: true, ignored: true, reason: "customer_not_linked" });
  }
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  if (!lineItems.length) return res.status(200).json({ received: true, ignored: true, reason: "empty_order" });
  const totalCents = Math.round(Number(order.total || 0) * 100);
  const tx = db.transaction(() => {
    const result = db.prepare("INSERT INTO orders (user_id,status,total_cents,wc_order_id,wc_status,currency,notes) VALUES (?,?,?,?,?,?,?)")
      .run(customer.id, "Nieuw", totalCents, wcOrderId, String(order.status || "pending"), String(order.currency || "EUR"), "Ontvangen via WooCommerce");
    const insert = db.prepare("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price_cents) VALUES (?,?,?,?,?)");
    for (const item of lineItems) {
      const quantity = Math.max(1, Math.trunc(Number(item.quantity) || 1));
      const unitPriceCents = Math.round((Number(item.total || 0) / quantity) * 100);
      insert.run(result.lastInsertRowid, item.product_id ? String(item.product_id) : null, String(item.name || "WooCommerce product"), quantity, unitPriceCents);
    }
    return Number(result.lastInsertRowid);
  });
  const localOrderId = tx();
  console.log(`WooCommerce order ${wcOrderId} ontvangen als lokale bestelling ${localOrderId}`);
  return res.status(200).json({ received: true, localOrderId });
});

app.get("/register",(req,res)=>res.redirect("/login"));
app.post("/register",(req,res)=>res.status(403).send("Accountregistratie is alleen mogelijk via beheer."));

app.get("/login",(req,res)=>{
  if(req.session.user)return res.redirect("/");
  const error=req.query.error?'<div class="alert">Inloggen is niet gelukt. Controleer je e-mailadres en wachtwoord.</div>':"";
  res.send(page(req,"Inloggen",`<section class="auth-card"><div class="eyebrow">BENDEMEN STUDIOS</div><h1>Welkom terug.</h1><p class="sub">Log in met je e-mailadres en wachtwoord om je account te beheren.</p>${req.query.disabled?'<div class="alert">Dit account is uitgeschakeld. Neem contact op met Bendemen Studios.</div>':""}${error}<form method="post" action="/login" class="stack"><label>E-mailadres<input name="email" type="email" autocomplete="username" required></label><label>Wachtwoord<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Inloggen <span>→</span></button></form></section>`));
});
app.post("/login",loginLimiter,async(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  const user=db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(email);
  if(!user||user.active!==1||!["admin","customer"].includes(user.role)||(user.role==="customer"&&!user.wc_customer_id)||!(await bcrypt.compare(password,user.password_hash)))return res.redirect("/login?error=1");
  req.session.regenerate(err=>{if(err)return res.status(500).send("Sessie kon niet worden gestart.");req.session.user={id:user.id,name:user.name,email:user.email,role:user.role};res.redirect(user.role==="admin"?"/admin":"/");});
});
app.get("/account/password",requireAuth,(req,res)=>{
 const body='<div class="page-title"><div class="eyebrow">ACCOUNT</div><h1>Wachtwoord wijzigen</h1><p>Je nieuwe wachtwoord wordt ook met WooCommerce gesynchroniseerd.</p>'+(req.query.updated?'<div class="alert">Wachtwoord succesvol gewijzigd in beide systemen.</div>':'')+'</div><div class="panel"><form method="post" action="/account/password" class="stack"><label>Huidig wachtwoord<input name="current_password" type="password" autocomplete="current-password" required></label><label>Nieuw wachtwoord<input name="new_password" type="password" minlength="6" maxlength="200" autocomplete="new-password" required></label><label>Herhaal nieuw wachtwoord<input name="confirm_password" type="password" minlength="6" maxlength="200" autocomplete="new-password" required></label><button class="primary">Wachtwoord wijzigen</button></form></div>';
 res.send(page(req,"Wachtwoord wijzigen",body));
});
app.post("/account/password",requireAuth,async(req,res)=>{
 const user=db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(req.session.user.id);
 const current=String(req.body.current_password||""),next=String(req.body.new_password||""),confirm=String(req.body.confirm_password||"");
 if(!user||!(await bcrypt.compare(current,user.password_hash)))return res.status(400).send("Het huidige wachtwoord is onjuist.");
 if(next.length<6||next.length>200||next!==confirm)return res.status(400).send("Het nieuwe wachtwoord moet minimaal 6 tekens bevatten en beide velden moeten overeenkomen.");
 try{
  if(user.role==="customer"&&user.wc_customer_id)await woo.setCustomerPassword(user.wc_customer_id,next);
  const hash=await bcrypt.hash(next,12);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash,user.id);
  res.redirect("/account/password?updated=1");
 }catch(err){console.error("Password sync failed:",err.message);res.status(502).send("Wachtwoord synchroniseren met WooCommerce is mislukt. Je oude wachtwoord blijft actief.");
 }
});
app.post("/logout",requireAuth,(req,res)=>req.session.destroy(()=>res.redirect("/login")));

app.get("/",requireAuth,(req,res)=>{
  const user=req.session.user,orders=getOrders(user.id,5);
  const monthly=db.prepare("SELECT COALESCE(SUM(amount_cents),0) total FROM monthly_costs WHERE user_id=? AND active=1").get(user.id).total;
  const orderSpend=db.prepare("SELECT COALESCE(SUM(total_cents),0) total FROM orders WHERE user_id=? AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get(user.id).total;
  const body=`<div class="hero"><div><div class="eyebrow">BENDEMEN SUPPLY PANEL</div><h1>Goedendag, ${esc(user.name.split(" ")[0])}.</h1><p>Alles rondom jouw Inkoop Bestellingen op één plek.</p></div><a class="primary inline" href="/orders">Mijn bestellingen <span>→</span></a></div>
  <div class="stats"><article class="stat"><span>Vaste maandkosten</span><strong>${money(monthly)}</strong><small>Actieve maandelijkse kosten</small></article><article class="stat"><span>Besteld deze maand</span><strong>${money(orderSpend)}</strong><small>Nieuwe orders deze maand</small></article><article class="stat"><span>Totaal bestellingen</span><strong>${db.prepare("SELECT COUNT(*) n FROM orders WHERE user_id=?").get(user.id).n}</strong><small>Alle geregistreerde orders</small></article></div>
  <section class="section-head"><div><div class="eyebrow">RECENT</div><h2>Recente bestellingen</h2></div><a class="textlink" href="/orders">Alle bestellingen →</a></section><div class="panel">${orders.length?orders.map(orderCard).join(""):'<div class="empty">Je hebt nog geen bestellingen.</div>'}</div>
  <div class="bottom-cta"><div><strong>Hetzelfde product nog een keer nodig?</strong><p>Bestel opnieuw vanuit je bestelgeschiedenis.</p></div><a class="secondary" href="/orders">Bekijk historie</a></div>`;
  res.send(page(req,"Dashboard",body));
});
app.get("/orders",requireAuth,(req,res)=>{const orders=getOrders(req.session.user.id);res.send(page(req,"Bestellingen",`<div class="page-title"><div class="eyebrow">JOUW OVERZICHT</div><h1>Bestellingen</h1><p>Bekijk je eerdere inkoopbestellingen en bestel ze eenvoudig opnieuw.</p></div><div class="panel">${orders.length?orders.map(orderCard).join(""):'<div class="empty">Nog geen bestellingen gevonden.</div>'}</div>`));});
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
  res.send(page(req,"Bestelling",`<a class="back" href="/orders">← Terug naar bestellingen</a><div class="page-title"><div class="eyebrow">BESTELLING BDS-${String(id).padStart(6,"0")}${fresh.wc_order_id?` · WC #${fresh.wc_order_id}`:""}</div><h1>Bestelling bekijken</h1><p>Aangemaakt op ${esc(o.created_at)} · <span class="status">${esc(displayOrderStatus(fresh))}</span></p></div>${payBlock}${cancelBlock}${invoiceBlock}<div class="panel"><div class="table-wrap"><table><thead><tr><th>Product</th><th>Aantal</th><th>Prijs per stuk</th><th>Totaal</th></tr></thead><tbody>${rows}</tbody></table></div><div class="total-line"><span>Ordertotaal</span><strong>${money(o.total_cents)}</strong></div></div>${fresh.allow_reorder!==0?`<form method="post" action="/orders/${id}/reorder" class="reorder-form"><div><strong>Dit product opnieuw bestellen?</strong><p>We maken direct een nieuwe order aan met dezelfde producten en aantallen.</p></div><button class="primary">Opnieuw bestellen <span>→</span></button></form>`:`<p class="hint">Dit is een maatwerkbestelling. Opnieuw bestellen is voor deze bestelling uitgeschakeld.</p>`}`));
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
 const customers=db.prepare("SELECT id,name,email,active,wc_customer_id FROM users WHERE role='customer' ORDER BY name").all();
 const rows=customers.map(c=>'<tr><td>'+esc(c.name)+'</td><td>'+esc(c.email)+'</td><td>'+(c.wc_customer_id?'#'+esc(c.wc_customer_id):'Niet gekoppeld')+'</td><td>'+(c.active?'Actief':'Uitgeschakeld')+'</td><td><a href="/admin/customers/'+c.id+'">Bekijken</a> · <form method="post" action="/admin/customers/'+c.id+'/access"><button class="secondary">'+(c.active?'Uitschakelen':'Activeren')+'</button></form></td></tr>').join("");
 res.send(page(req,"Beheer",'<div class="page-title"><div class="eyebrow">BEHEER</div><h1>Klanten</h1><p>Alleen WooCommerce-klanten die je hier toevoegt krijgen toegang.</p><a class="primary inline" href="/admin/customers/search">Klant toevoegen →</a></div><div class="panel"><table><thead><tr><th>Naam</th><th>E-mail</th><th>WooCommerce</th><th>Toegang</th><th>Actie</th></tr></thead><tbody>'+(rows||'<tr><td colspan="5">Nog geen klanten toegevoegd.</td></tr>')+'</tbody></table></div>'));
});
app.get("/admin/customers/search",requireAuth,requireAdmin,async(req,res)=>{
 const q=String(req.query.q||"").trim();let customers=[],error="";
 if(q.length>=2){try{customers=await woo.searchCustomers(q);}catch(err){console.error(err.message);error="WooCommerce-klanten konden niet worden opgehaald. Controleer de API-instellingen.";}}
 const rows=customers.map(c=>{
  const email=String(c.email||"").trim().toLowerCase(),name=[c.first_name,c.last_name].filter(Boolean).join(" ")||email;
  const existing=email?db.prepare("SELECT id,wc_customer_id FROM users WHERE email=? COLLATE NOCASE").get(email):null;
  return '<div class="order-row"><div><strong>'+esc(name)+'</strong><small>'+esc(email)+'</small></div><div>WooCommerce #'+esc(c.id)+'</div><div>'+(existing?(existing.wc_customer_id?'Al gekoppeld':'Supply-account bestaat'):'Nog geen Supply-account')+'</div><form method="post" action="/admin/customers/link" class="stack"><input type="hidden" name="wc_customer_id" value="'+esc(c.id)+'"><label>Startwachtwoord<input name="password" type="password" minlength="6" maxlength="200" required placeholder="Minimaal 6 tekens"></label><button class="primary">'+(existing?'Account koppelen / herstellen':'Toegang geven')+'</button></form></div>';
 }).join("");
 res.send(page(req,"Klant toevoegen",'<div class="page-title"><div class="eyebrow">WOOCOMMERCE</div><h1>Klant toevoegen</h1><p>Zoek een geregistreerde WooCommerce-klant op naam of e-mailadres.</p></div><div class="panel"><form method="get" action="/admin/customers/search" class="stack"><label>Naam of e-mailadres<input name="q" value="'+esc(q)+'" minlength="2" required placeholder="Naam of e-mailadres"></label><button class="primary">Zoeken in WooCommerce</button></form></div>'+(error?'<div class="alert">'+esc(error)+'</div>':'')+'<div class="panel">'+(q.length<2?'<div class="empty">Vul minimaal twee tekens in.</div>':rows||'<div class="empty">Geen WooCommerce-klanten gevonden.</div>')+'</div><a class="back" href="/admin">← Terug naar klanten</a>'));
});
app.post("/admin/customers/link",requireAuth,requireAdmin,async(req,res)=>{
 const wcId=String(req.body.wc_customer_id||"").trim(),password=String(req.body.password||"");
 if(!/^\\d+$/.test(wcId)||password.length<6||password.length>200)return res.status(400).send("Ongeldig account of wachtwoord (minimaal 6 tekens).");
 try{
  const c=await woo.getCustomer(wcId),email=String(c.email||"").trim().toLowerCase(),name=[c.first_name,c.last_name].filter(Boolean).join(" ")||email;
  if(!email||email.indexOf("@")<1)return res.status(400).send("Deze WooCommerce-klant heeft geen geldig e-mailadres.");
  const hash=await bcrypt.hash(password,12),existing=db.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE").get(email);
  if(existing)db.prepare("UPDATE users SET name=?,password_hash=?,role='customer',active=1,wc_customer_id=? WHERE id=?").run(name,hash,wcId,existing.id);
  else db.prepare("INSERT INTO users (name,email,password_hash,role,active,wc_customer_id) VALUES (?,?,?,'customer',1,?)").run(name,email,hash,wcId);
  res.redirect("/admin");
 }catch(err){console.error("WooCommerce customer linking:",err.message);res.status(502).send("Klant koppelen is mislukt. Controleer de WooCommerce API en klantkoppeling.");}
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
  res.send(page(req,"Klant",`<h1>${esc(customer.name)}</h1><p>${esc(customer.email)}</p><div class="panel">${orders.map(o=>orderCard(o)+`<a class="textlink" href="/admin/orders/${o.id}/products">Producten beheren →</a>`).join("")}</div>`));
});


app.get("/costs",requireAuth,(req,res)=>res.redirect("/services"));
app.get("/subscriptions",requireAuth,(req,res)=>res.redirect("/services"));
app.get("/services",requireAuth,(req,res)=>{
 const costs=db.prepare("SELECT * FROM monthly_costs WHERE user_id=? ORDER BY active DESC,id DESC").all(req.session.user.id);
 const costRows=costs.map(c=>'<tr><td>'+esc(c.name)+'</td><td>'+esc(c.interval)+'</td><td>'+money(c.amount_cents)+'</td><td>'+(c.active?'Actief':'Gestopt')+'</td></tr>').join("");
 const subs=db.prepare("SELECT * FROM recurring_orders WHERE user_id=? ORDER BY id DESC").all(req.session.user.id);
 const cards=subs.map(sub=>{const items=db.prepare("SELECT product_name,quantity,unit_price_cents FROM recurring_order_items WHERE recurring_order_id=?").all(sub.id);return '<div class="order-row"><div><strong>'+esc(sub.name)+'</strong><small>'+esc(sub.interval)+' · '+esc(sub.status)+'</small></div><div class="order-products">'+esc(items.map(x=>x.quantity+'× '+x.product_name).join(', ')||'Geen producten gekoppeld')+'</div><strong>'+money(sub.amount_cents)+'</strong><div>'+(sub.next_payment?'Volgende betaling: '+esc(sub.next_payment):'')+'</div></div>';}).join("");
 res.send(page(req,"Diensten & kosten",'<div class="page-title"><div class="eyebrow">JOUW OVERZICHT</div><h1>Diensten & kosten</h1><p>Bekijk je gekoppelde diensten, abonnementen en terugkerende kosten.</p></div><div class="panel"><h2>Diensten & abonnementen</h2>'+(cards||'<div class="empty">Er zijn nog geen diensten aan je account gekoppeld.</div>')+'</div><div class="panel"><h2>Maandelijkse kosten</h2><div class="table-wrap"><table><thead><tr><th>Omschrijving</th><th>Periode</th><th>Bedrag</th><th>Status</th></tr></thead><tbody>'+(costRows||'<tr><td colspan="4">Er zijn nog geen maandkosten gekoppeld.</td></tr>')+'</tbody></table></div></div>'));
});
app.get("/admin/products",requireAuth,requireAdmin,(req,res)=>{
 const products=db.prepare("SELECT * FROM products ORDER BY active DESC,name").all();
 const rows=products.map(p=>'<tr><td>'+esc(p.name)+'</td><td>'+esc(p.sku||'—')+'</td><td>'+money(p.price_cents)+'</td><td>'+money(p.price_cents)+'</td><td>'+money(p.price_cents)+'</td><td>'+esc(p.source)+'</td><td>'+(p.wc_product_id?'Woo #'+esc(p.wc_product_id):'Handmatig')+'</td></tr>').join("");
 res.send(page(req,"Productbeheer",'<div class="page-title"><div class="eyebrow">BEHEER</div><h1>Producten</h1><p>Importeer WooCommerce-producten of voeg ze handmatig toe.</p></div><div class="panel"><h2>WooCommerce synchroniseren</h2><form method="post" action="/admin/products/sync"><button class="primary">Producten ophalen uit WooCommerce</button></form></div><div class="panel"><h2>Handmatig product toevoegen</h2><form method="post" action="/admin/products" class="stack"><label>Productnaam<input name="name" maxlength="180" required></label><label>SKU<input name="sku" maxlength="100"></label><label>Verkoopprijs in euro<input name="price" inputmode="decimal" placeholder="0,00" required></label><label>Product-URL<input name="product_url" type="url"></label><button class="primary">Product opslaan</button></form></div><div class="panel"><h2>Productcatalogus</h2><div class="table-wrap"><table><thead><tr><th>Product</th><th>SKU</th><th>Verkoopprijs</th><th>Bron</th><th>Koppeling</th></tr></thead><tbody>'+(rows||'<tr><td colspan="5">Nog geen producten. Synchroniseer WooCommerce of voeg handmatig toe.</td></tr>')+'</tbody></table></div></div>'));
});
app.post("/admin/products",requireAuth,requireAdmin,(req,res)=>{
 const name=String(req.body.name||"").trim(),sku=String(req.body.sku||"").trim(),price=moneyInput(req.body.price),cost=moneyInput(req.body.cost||"0"),url=String(req.body.product_url||"").trim();
 if(!name||!Number.isSafeInteger(price)||price<0||!Number.isSafeInteger(cost)||cost<0||url&&!/^https?:\/\//i.test(url))return res.status(400).send("Ongeldig product, verkoopprijs of inkoopkosten.");
 db.prepare("INSERT INTO products (name,sku,price_cents,product_url,source) VALUES (?,?,?,?,'manual')").run(name,sku||null,price,url||null);res.redirect("/admin/products");
});
app.post("/admin/products/sync",requireAuth,requireAdmin,async(req,res)=>{
 try{
  let pageNo=1,count=0;
  while(true){const list=await woo.listProducts(pageNo,100);if(!list.length)break;
   const upsert=db.prepare("INSERT INTO products (wc_product_id,name,sku,description,price_cents,product_url,image_url,source,active,updated_at) VALUES (?,?,?,?,?,?,?,'woocommerce',1,CURRENT_TIMESTAMP) ON CONFLICT(wc_product_id) DO UPDATE SET name=excluded.name,sku=excluded.sku,description=excluded.description,price_cents=excluded.price_cents,product_url=excluded.product_url,image_url=excluded.image_url,active=1,updated_at=CURRENT_TIMESTAMP");
   const tx=db.transaction(items=>{for(const p of items){const cents=Math.round(Number(p.price||0)*100);upsert.run(String(p.id),p.name||'Product',p.sku||null,p.description||null,cents,p.permalink||null,p.images&&p.images[0]?p.images[0].src:null);}});
   tx(list);count+=list.length;if(list.length<100)break;pageNo++;
  }
  res.redirect("/admin/products?sync="+count);
 }catch(err){console.error("WooCommerce product sync:",err.message);res.status(502).send("WooCommerce synchroniseren is mislukt. Controleer WC_STORE_URL, WC_CONSUMER_KEY en WC_CONSUMER_SECRET in .env.");}
});
app.get("/admin/orders/:id/products",requireAuth,requireAdmin,(req,res)=>{
 const id=Number(req.params.id),order=db.prepare("SELECT o.*,u.name customer_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?").get(id);if(!order)return res.status(404).send("Bestelling niet gevonden.");
 const products=db.prepare("SELECT id,name,price_cents FROM products WHERE active=1 ORDER BY name").all(),items=db.prepare("SELECT * FROM order_items WHERE order_id=?").all(id);
 const options=products.map(p=>'<option value="'+p.id+'">'+esc(p.name)+' — '+money(p.price_cents)+'</option>').join("");
 const lines=items.map(x=>'<tr><td>'+esc(x.product_name)+'</td><td>'+x.quantity+'</td><td>'+money(x.unit_price_cents)+'</td></tr>').join("");
 res.send(page(req,"Producten koppelen",'<a class="back" href="/admin">← Beheer</a><div class="page-title"><h1>Producten koppelen aan BDS-'+String(id).padStart(6,'0')+'</h1><p>Klant: '+esc(order.customer_name)+'</p></div><div class="panel"><form method="post" action="/admin/orders/'+id+'/products" class="stack"><label>Product<select name="product_id" required>'+options+'</select></label><label>Aantal<input name="quantity" type="number" min="1" max="999" value="1" required></label><button class="primary">Product toevoegen aan bestelling</button></form></div><div class="panel"><h2>Maatwerk / kostenregel toevoegen</h2><p>Voor maatwerk dat niet als WooCommerce-product bestaat. Wordt alleen aan deze bestelling toegevoegd.</p><form method="post" action="/admin/orders/'+id+'/custom-item" class="stack"><label>Omschrijving<input name="name" maxlength="180" placeholder="Bijv. 3D-print op maat" required></label><label>Prijs per stuk in euro<input name="price" inputmode="decimal" placeholder="0,00" required></label><label>Aantal<input name="quantity" type="number" min="1" max="999" value="1" required></label><button class="primary">Maatwerkregel toevoegen</button></form></div><div class="panel"><h2>Huidige orderregels</h2><table><thead><tr><th>Product</th><th>Aantal</th><th>Prijs per stuk</th></tr></thead><tbody>'+lines+'</tbody></table></div>'));
});
app.post("/admin/orders/:id/custom-item",requireAuth,requireAdmin,(req,res)=>{
 const id=Number(req.params.id),name=String(req.body.name||"").trim().slice(0,180),price=moneyInput(req.body.price),qty=Number(req.body.quantity);
 const order=db.prepare("SELECT id FROM orders WHERE id=?").get(id);
 if(!order||!name||price===null||price<0||!Number.isSafeInteger(price)||!Number.isInteger(qty)||qty<1||qty>999)return res.status(400).send("Ongeldige maatwerkregel. Controleer omschrijving, prijs en aantal.");
 db.prepare("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price_cents) VALUES (?,NULL,?,?,?)").run(id,name,qty,price);
 db.prepare("UPDATE orders SET total_cents=(SELECT COALESCE(SUM(quantity*unit_price_cents),0) FROM order_items WHERE order_id=?) WHERE id=?").run(id,id);
 res.redirect("/admin/orders/"+id+"/products");
});
app.post("/admin/orders/:id/products",requireAuth,requireAdmin,(req,res)=>{
 const id=Number(req.params.id),product=db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(Number(req.body.product_id)),qty=Number(req.body.quantity);
 const order=db.prepare("SELECT id FROM orders WHERE id=?").get(id);if(!order||!product||!Number.isInteger(qty)||qty<1||qty>999)return res.status(400).send("Ongeldige bestelling, productkeuze of aantal.");
 db.prepare("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price_cents) VALUES (?,?,?,?,?)").run(id,product.wc_product_id||("local:"+String(product.id)),product.name,qty,product.price_cents);
 db.prepare("UPDATE orders SET total_cents=(SELECT COALESCE(SUM(quantity*unit_price_cents),0) FROM order_items WHERE order_id=?) WHERE id=?").run(id,id);
 res.redirect("/admin/orders/"+id+"/products");
});
app.get("/admin/subscriptions",requireAuth,requireAdmin,(req,res)=>{
 const subs=db.prepare("SELECT r.*,u.name customer_name FROM recurring_orders r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC").all();
 const customers=db.prepare("SELECT id,name FROM users WHERE role='customer' AND active=1 ORDER BY name").all();
 const products=db.prepare("SELECT id,name,price_cents FROM products WHERE active=1 ORDER BY name").all();
 const options=customers.map(c=>'<option value="'+c.id+'">'+esc(c.name)+'</option>').join("");
 const rows=subs.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+esc(x.customer_name)+'</td><td>'+esc(x.status)+'</td><td>'+money(x.amount_cents)+'</td><td><a href="/admin/subscriptions/'+x.id+'/products">Producten koppelen</a></td></tr>').join("");
 res.send(page(req,"Abonnementen beheren",'<div class="page-title"><h1>Abonnementen</h1><p>Maak een dienst aan voor een bestaande klant.</p></div><div class="panel"><form method="post" action="/admin/subscriptions" class="stack"><label>Klant<select name="user_id" required>'+options+'</select></label><label>Naam dienst<input name="name" maxlength="180" required></label><label>Bedrag per periode<input name="amount" inputmode="decimal" required placeholder="0,00"></label><label>Periode<select name="interval"><option value="month">Maand</option><option value="year">Jaar</option><option value="week">Week</option></select></label><label>Eerste besteldatum<input name="next_payment" type="date" required></label><button class="primary">Abonnement aanmaken</button></form></div><div class="panel"><table><thead><tr><th>Dienst</th><th>Klant</th><th>Status</th><th>Bedrag</th><th></th></tr></thead><tbody>'+(rows||'<tr><td colspan="5">Nog geen abonnementen.</td></tr>')+'</tbody></table></div>'));
});
app.post("/admin/subscriptions",requireAuth,requireAdmin,(req,res)=>{
 const user=db.prepare("SELECT id FROM users WHERE id=? AND role='customer'").get(Number(req.body.user_id)),name=String(req.body.name||"").trim(),amount=moneyInput(req.body.amount),interval=["week","month","year"].includes(req.body.interval)?req.body.interval:"month",next=String(req.body.next_payment||"");
 if(!user||!name||!Number.isSafeInteger(amount)||amount<0||!next||next&&!/^\d{4}-\d{2}-\d{2}$/.test(next))return res.status(400).send("Controleer de abonnementsgegevens en kies een eerste besteldatum.");
 db.prepare("INSERT INTO recurring_orders (user_id,name,amount_cents,interval,next_payment) VALUES (?,?,?,?,?)").run(user.id,name,amount,interval,next||null);res.redirect("/admin/subscriptions");
});
app.get("/admin/subscriptions/:id/products",requireAuth,requireAdmin,(req,res)=>{
 const id=Number(req.params.id),sub=db.prepare("SELECT r.*,u.name customer_name FROM recurring_orders r JOIN users u ON u.id=r.user_id WHERE r.id=?").get(id);if(!sub)return res.status(404).send("Abonnement niet gevonden.");
 const products=db.prepare("SELECT id,name,price_cents FROM products WHERE active=1 ORDER BY name").all(),options=products.map(p=>'<option value="'+p.id+'">'+esc(p.name)+' — '+money(p.price_cents)+'</option>').join("");
 const lines=db.prepare("SELECT * FROM recurring_order_items WHERE recurring_order_id=?").all(id).map(x=>'<tr><td>'+esc(x.product_name)+'</td><td>'+x.quantity+'</td><td>'+money(x.unit_price_cents)+'</td></tr>').join("");
 res.send(page(req,"Abonnementproducten",'<div class="page-title"><h1>Producten koppelen</h1><p>'+esc(sub.name)+' · '+esc(sub.customer_name)+'</p></div><div class="panel"><p>Deze bestelling wordt automatisch opnieuw aangemaakt op de volgende besteldatum.</p></div><div class="panel"><form method="post" action="/admin/subscriptions/'+id+'/products" class="stack"><label>Product<select name="product_id" required>'+options+'</select></label><label>Aantal<input name="quantity" type="number" min="1" max="999" value="1" required></label><button class="primary">Product koppelen</button></form></div><div class="panel"><table><thead><tr><th>Product</th><th>Aantal</th><th>Prijs per stuk</th></tr></thead><tbody>'+lines+'</tbody></table></div>'));
});
app.post("/admin/subscriptions/:id/products",requireAuth,requireAdmin,(req,res)=>{
 const id=Number(req.params.id),sub=db.prepare("SELECT id FROM recurring_orders WHERE id=?").get(id),p=db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(Number(req.body.product_id)),qty=Number(req.body.quantity);
 if(!sub||!p||!Number.isInteger(qty)||qty<1||qty>999)return res.status(400).send("Ongeldige invoer.");
 db.prepare("INSERT INTO recurring_order_items (recurring_order_id,product_id,product_name,quantity,unit_price_cents) VALUES (?,?,?,?,?)").run(id,p.wc_product_id||String(p.id),p.name,qty,p.price_cents);
 db.prepare("UPDATE recurring_orders SET amount_cents=(SELECT COALESCE(SUM(quantity*unit_price_cents),0) FROM recurring_order_items WHERE recurring_order_id=?) WHERE id=?").run(id,id);res.redirect("/admin/subscriptions/"+id+"/products");
});
app.get("/admin/costs",requireAuth,requireAdmin,(req,res)=>res.redirect("/admin/orders"));

app.get("/health",(_req,res)=>res.json({ok:true}));
app.use((err,req,res,next)=>{console.error(err);res.status(500).send("Er is iets misgegaan.");});
function addBillingPeriod(dateString,interval){
 const date=new Date(dateString+"T12:00:00.000Z");
 if(interval==="week")date.setUTCDate(date.getUTCDate()+7);
 else if(interval==="year")date.setUTCFullYear(date.getUTCFullYear()+1);
 else {const day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+1);const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,last));}
 return date.toISOString().slice(0,10);
}
async function processRecurringOrders(){
 const today=new Date().toISOString().slice(0,10);
 const due=db.prepare("SELECT * FROM recurring_orders WHERE status='active' AND next_payment IS NOT NULL AND next_payment<=? AND (last_generated_for IS NULL OR last_generated_for<next_payment) ORDER BY id").all(today);
 for(const sub of due){
  const items=db.prepare("SELECT * FROM recurring_order_items WHERE recurring_order_id=?").all(sub.id);
  if(!items.length){console.warn("Terugkerende bestelling "+sub.id+" overgeslagen: geen orderregels.");continue;}
  try{
   const tx=db.transaction(()=>{
    const current=db.prepare("SELECT * FROM recurring_orders WHERE id=? AND status='active' AND next_payment=? AND (last_generated_for IS NULL OR last_generated_for<next_payment)").get(sub.id,sub.next_payment);
    if(!current)return null;
    const lines=items.map(x=>({product_id:x.product_id,product_name:x.product_name,quantity:x.quantity,unit_price_cents:x.unit_price_cents}));
    const id=createOrder(current.user_id,lines,null,"Automatisch terugkerende bestelling: "+current.name,current.id);
    db.prepare("UPDATE recurring_orders SET last_generated_for=?,next_payment=? WHERE id=?").run(current.next_payment,addBillingPeriod(current.next_payment,current.interval),current.id);
    return id;
   });
   const orderId=tx();
   if(orderId){await syncWooOrder(orderId);await sendOrderWebhook(orderId);console.log("Terugkerende bestelling aangemaakt:",orderId);}
  }catch(err){console.error("Terugkerende bestelling mislukt voor "+sub.id+":",err.message);}
 }
}
setTimeout(()=>processRecurringOrders().catch(err=>console.error("Recurring scheduler:",err.message)),5000);
setInterval(()=>processRecurringOrders().catch(err=>console.error("Recurring scheduler:",err.message)),60000).unref();
app.listen(PORT, "0.0.0.0", ()=>console.log(`Bendemen Supply Panel draait op poort ${PORT}`));
