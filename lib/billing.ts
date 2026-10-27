import type { Plan, Profile } from "./types";

export type BillingConfig = { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string; SITE_URL?: string };
type Row = Record<string, unknown>;
export type StripeEvent = { id: string; type: string; created: number; livemode: boolean; data: { object: Row & { id: string } } };
export type BillingLock = { resource: string; token: string; revision: number };
export class BillingError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const API_VERSION = "2025-06-30.basil";
const rec = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): Row[] => Array.isArray(value) ? value.map(rec) : [];
const reference = (value: unknown): string => typeof value === "string" ? value : String(rec(value).id || "");
const iso = (value: unknown): string => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 1) throw new BillingError(502, "O provedor retornou uma data de cobrança inválida.");
  return new Date(seconds * 1000).toISOString();
};
const now = () => Math.floor(Date.now() / 1000);
function stripeId(value: string): string {
  if (!/^[a-z]+_[a-zA-Z0-9_]+$/.test(value)) throw new BillingError(400, "Identificador do provedor inválido.");
  return encodeURIComponent(value);
}
export function canonicalBillingOrigin(config: BillingConfig): string {
  let url: URL;
  try { url = new URL(config.SITE_URL || ""); } catch { throw new BillingError(503, "Configure o endereço oficial da plataforma para habilitar cobranças."); }
  const localTest = config.STRIPE_SECRET_KEY?.startsWith("sk_test_") && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(localTest && url.protocol === "http:"))) throw new BillingError(503, "O endereço oficial de cobrança precisa ser uma origem HTTPS válida.");
  return url.origin;
}
export function billingStatus(config: BillingConfig) {
  const missing: string[] = [];
  if (!/^sk_(test|live)_\S+$/.test(config.STRIPE_SECRET_KEY || "")) missing.push("STRIPE_SECRET_KEY");
  if (!/^whsec_\S+$/.test(config.STRIPE_WEBHOOK_SECRET || "")) missing.push("STRIPE_WEBHOOK_SECRET");
  try { canonicalBillingOrigin(config); } catch { missing.push("SITE_URL"); }
  return { provider: "stripe" as const, configured: missing.length === 0, mode: config.STRIPE_SECRET_KEY?.startsWith("sk_live_") ? "live" : config.STRIPE_SECRET_KEY?.startsWith("sk_test_") ? "test" : null, missing };
}
// With no test key, production reads fail closed to live data only.
export function billingLiveMode(config: BillingConfig): boolean { return !config.STRIPE_SECRET_KEY?.startsWith("sk_test_"); }
function requireConfigured(config: BillingConfig) {
  if (!billingStatus(config).configured) throw new BillingError(503, "As cobranças Stripe ainda estão aguardando configuração. Seu plano atual permanece disponível.");
}
export function billingReturnUrl(config: BillingConfig, relative = "/assinatura"): string {
  if (!relative.startsWith("/") || relative.startsWith("//") || relative.includes("\\")) throw new BillingError(400, "Endereço de retorno inválido.");
  const origin = canonicalBillingOrigin(config);
  const url = new URL(relative, origin);
  if (url.origin !== origin) throw new BillingError(400, "Endereço de retorno inválido.");
  return url.toString();
}
export async function stripeRequest<T = Row>(config: BillingConfig, path: string, body?: URLSearchParams, idempotencyKey?: string, fetcher: typeof fetch = fetch): Promise<T> {
  if (!config.STRIPE_SECRET_KEY) throw new BillingError(503, "Stripe ainda não foi configurado.");
  if (!path.startsWith("/v1/")) throw new BillingError(500, "Requisição de cobrança inválida.");
  if (body && !idempotencyKey) throw new BillingError(500, "A operação de cobrança precisa de uma chave de idempotência.");
  const headers: Record<string, string> = { Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`, "Stripe-Version": API_VERSION };
  if (body) { headers["Content-Type"] = "application/x-www-form-urlencoded"; headers["Idempotency-Key"] = idempotencyKey!; }
  let response: Response;
  try { response = await fetcher(`https://api.stripe.com${path}`, { method: body ? "POST" : "GET", headers, body, redirect: "manual", signal: AbortSignal.timeout(12_000) }); }
  catch { throw new BillingError(503, "O provedor de pagamento está indisponível. Tente novamente em instantes."); }
  if (!response.ok) throw new BillingError(response.status === 429 || response.status >= 500 ? 503 : 502, "O provedor não confirmou a operação. Nenhum acesso adicional foi liberado.");
  return await response.json() as T;
}

// The original request bytes are authenticated. WebCrypto verifies HMAC without a string equality comparison.
export async function verifyStripeSignature(payload: Uint8Array | string, signature: string | null, secret: string, timestamp = now(), tolerance = 300): Promise<boolean> {
  if (!signature || signature.length > 4096 || !secret || tolerance <= 0) return false;
  const parts = signature.split(",").map((s) => s.trim().split("="));
  const times = parts.filter(([key]) => key === "t").map(([, value]) => value);
  const signatures = parts.filter(([key, value]) => key === "v1" && /^[a-f0-9]{64}$/i.test(value || "")).map(([, value]) => value);
  if (times.length !== 1 || !/^\d+$/.test(times[0] || "") || !signatures.length || Math.abs(timestamp - Number(times[0])) > tolerance) return false;
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${times[0]}.`);
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const signed = new Uint8Array(prefix.length + bytes.length); signed.set(prefix); signed.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  let valid = false;
  for (const candidate of signatures) {
    const signatureBytes = Uint8Array.from(candidate.match(/.{2}/g)!, (hex) => parseInt(hex, 16));
    const matches = await crypto.subtle.verify("HMAC", key, signatureBytes, signed);
    valid = matches || valid;
  }
  return valid;
}
export function parseStripeEvent(value: unknown): StripeEvent {
  const event = rec(value), object = rec(rec(event.data).object);
  if (typeof event.id !== "string" || !/^evt_[a-zA-Z0-9]+$/.test(event.id) || typeof event.type !== "string" || typeof event.created !== "number" || typeof event.livemode !== "boolean" || typeof object.id !== "string") throw new BillingError(400, "Evento Stripe inválido.");
  return event as unknown as StripeEvent;
}
async function one(db: D1Database, sql: string, ...values: (string | number | null)[]) { return db.prepare(sql).bind(...values).first<Row>(); }
export async function acquireBillingLock(db: D1Database, resource: string): Promise<BillingLock> {
  const token = crypto.randomUUID();
  const result = await db.prepare("INSERT INTO billing_locks (resource_id, token, expires_at, revision) VALUES (?, ?, unixepoch() + 120, 1) ON CONFLICT(resource_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at, revision = billing_locks.revision + 1 WHERE billing_locks.expires_at <= unixepoch()").bind(resource, token).run();
  if (!result.meta.changes) throw new BillingError(503, "Uma atualização desta cobrança já está em andamento. Tente novamente.");
  const lock = await one(db, "SELECT revision FROM billing_locks WHERE resource_id = ? AND token = ?", resource, token);
  if (!lock) throw new BillingError(503, "A atualização da cobrança precisa ser repetida.");
  return { resource, token, revision: Number(lock.revision) };
}
export async function releaseBillingLock(db: D1Database, lock: BillingLock) {
  // Keep revision monotonic even after releasing the lease.
  await db.prepare("UPDATE billing_locks SET expires_at = 0 WHERE resource_id = ? AND token = ?").bind(lock.resource, lock.token).run();
}
const fence = "EXISTS (SELECT 1 FROM billing_locks WHERE resource_id = ? AND token = ? AND revision = ? AND expires_at > unixepoch())";
const fenceValues = (lock: BillingLock): (string | number)[] => [lock.resource, lock.token, lock.revision];
async function digest(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (n) => n.toString(16).padStart(2, "0")).join(""); }
function trustedStripeUrl(value: unknown, hosts: string[]): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new BillingError(502, "O provedor retornou um endereço inválido."); }
  if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.username || url.password) throw new BillingError(502, "O provedor retornou um endereço não autorizado.");
  return url.toString();
}

export async function createCheckout(db: D1Database, config: BillingConfig, profile: Profile, plan: Plan, period?: string, fetcher: typeof fetch = fetch): Promise<{ url: string; sessionId: string }> {
  requireConfigured(config);
  if (!plan.active || !plan.visible || plan.price <= 0) throw new BillingError(400, "Escolha um plano pago disponível para assinatura.");
  if (period && period !== plan.period) throw new BillingError(400, "Esta periodicidade não está disponível para o plano selecionado.");
  const amount = Math.round(plan.price * 100);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 99_999_999) throw new BillingError(400, "O preço deste plano precisa ser revisado pelo administrador.");
  const mode = billingLiveMode(config) ? 1 : 0;
  const lock = await acquireBillingLock(db, `checkout:${mode}:${profile.id}`);
  try {
    const existingSubscription = await one(db, "SELECT id FROM subscriptions WHERE user_id = ? AND livemode = ? AND status NOT IN ('canceled', 'incomplete_expired') LIMIT 1", profile.id, mode);
    if (existingSubscription) throw new BillingError(409, "Você já possui uma assinatura. Use Gerenciar assinatura para consultar ou cancelar sua cobrança atual.");
    let attempt = await one(db, "SELECT * FROM billing_checkouts WHERE user_id = ? AND livemode = ? AND status IN ('creating', 'open') AND expires_at > unixepoch() ORDER BY created_at DESC LIMIT 1", profile.id, mode);
    if (attempt && (attempt.plan_id !== plan.id || attempt.amount_cents !== amount || attempt.period !== plan.period)) throw new BillingError(409, "Já existe uma sessão de contratação em aberto. Finalize-a ou aguarde sua expiração antes de escolher outro plano.");
    if (attempt?.provider_session_id) {
      const session = await stripeRequest(config, `/v1/checkout/sessions/${stripeId(String(attempt.provider_session_id))}`, undefined, undefined, fetcher);
      if (session.status === "open") return { url: trustedStripeUrl(session.url, ["checkout.stripe.com"]), sessionId: String(session.id) };
      if (session.status === "complete") throw new BillingError(409, "Sua contratação está sendo confirmada. Aguarde a confirmação do provedor.");
      await db.prepare("UPDATE billing_checkouts SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").bind(String(attempt.id), profile.id).run();
      attempt = null;
    }
    let customer = await one(db, "SELECT * FROM billing_customers WHERE user_id = ? AND livemode = ?", profile.id, mode);
    if (!customer) {
      const customerResult = await stripeRequest(config, "/v1/customers", new URLSearchParams({ "metadata[userId]": profile.id }), `cafegestor-customer-${await digest(`${mode}:${profile.id}`)}`, fetcher);
      stripeId(String(customerResult.id));
      await db.prepare("INSERT INTO billing_customers (user_id, provider_customer_id, livemode) VALUES (?, ?, ?) ON CONFLICT(user_id, livemode) DO NOTHING").bind(profile.id, String(customerResult.id), mode).run();
      customer = (await one(db, "SELECT * FROM billing_customers WHERE user_id = ? AND livemode = ?", profile.id, mode))!;
    }
    if (!attempt) {
      const remote = await stripeRequest(config, `/v1/subscriptions?customer=${stripeId(String(customer.provider_customer_id))}&status=all&limit=100`, undefined, undefined, fetcher);
      if (remote.has_more || list(remote.data).some((s) => !["canceled", "incomplete_expired"].includes(String(s.status)))) throw new BillingError(409, "Já existe uma assinatura neste cliente Stripe. Use o portal de cobrança para gerenciá-la.");
      const snapshot = { ...plan, trialDays: customer.trial_used ? 0 : plan.trialDays };
      const id = crypto.randomUUID(), expiresAt = now() + 3600;
      await db.prepare("INSERT INTO billing_checkouts (id, user_id, plan_id, amount_cents, period, plan_snapshot, provider_customer_id, expires_at, livemode) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE " + fence).bind(id, profile.id, plan.id, amount, plan.period, JSON.stringify(snapshot), String(customer.provider_customer_id), expiresAt, mode, ...fenceValues(lock)).run();
      attempt = (await one(db, "SELECT * FROM billing_checkouts WHERE id = ? AND user_id = ?", id, profile.id))!;
      if (!attempt) throw new BillingError(503, "A sessão precisa ser criada novamente.");
    }
    const snapshot = JSON.parse(String(attempt.plan_snapshot)) as Plan;
    const params = new URLSearchParams({
      mode: "subscription", customer: String(customer.provider_customer_id), client_reference_id: profile.id, locale: "pt-BR",
      success_url: billingReturnUrl(config, "/assinatura?billing=success"), cancel_url: billingReturnUrl(config, "/assinatura?billing=canceled"),
      expires_at: String(attempt.expires_at), "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "brl",
      "line_items[0][price_data][unit_amount]": String(attempt.amount_cents), "line_items[0][price_data][recurring][interval]": attempt.period === "annual" ? "year" : "month",
      "line_items[0][price_data][product_data][name]": `CaféGestor ${snapshot.name}`,
      "metadata[userId]": profile.id, "metadata[planId]": String(attempt.plan_id), "metadata[checkoutId]": String(attempt.id),
      "subscription_data[metadata][userId]": profile.id, "subscription_data[metadata][planId]": String(attempt.plan_id), "subscription_data[metadata][checkoutId]": String(attempt.id),
    });
    if (snapshot.trialDays > 0) { params.set("subscription_data[trial_period_days]", String(snapshot.trialDays)); params.set("subscription_data[trial_settings][end_behavior][missing_payment_method]", "cancel"); }
    const session = await stripeRequest(config, "/v1/checkout/sessions", params, `cafegestor-checkout-${attempt.id}`, fetcher);
    const url = trustedStripeUrl(session.url, ["checkout.stripe.com"]);
    stripeId(String(session.id));
    const saved = await db.prepare("UPDATE billing_checkouts SET provider_session_id = ?, checkout_url = ?, status = 'open', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND " + fence).bind(String(session.id), url, String(attempt.id), profile.id, ...fenceValues(lock)).run();
    if (!saved.meta.changes) throw new BillingError(503, "A sessão foi criada e precisa ser recuperada. Tente novamente.");
    return { url, sessionId: String(session.id) };
  } finally { await releaseBillingLock(db, lock); }
}
export async function createPortal(db: D1Database, config: BillingConfig, profile: Profile, fetcher: typeof fetch = fetch): Promise<{ url: string }> {
  requireConfigured(config);
  const customer = await one(db, "SELECT provider_customer_id FROM billing_customers WHERE user_id = ? AND livemode = ?", profile.id, billingLiveMode(config) ? 1 : 0);
  if (!customer) throw new BillingError(404, "Você ainda não possui um cadastro de cobrança Stripe.");
  const session = await stripeRequest(config, "/v1/billing_portal/sessions", new URLSearchParams({ customer: String(customer.provider_customer_id), return_url: billingReturnUrl(config), locale: "pt-BR" }), `cafegestor-portal-${crypto.randomUUID()}`, fetcher);
  return { url: trustedStripeUrl(session.url, ["billing.stripe.com"]) };
}

function subscriptionForInvoice(invoice: Row): string {
  return reference(rec(rec(invoice.parent).subscription_details).subscription) || reference(invoice.subscription);
}
function validateSubscription(subscription: Row, attempt: Row, customerId: string) {
  const metadata = rec(subscription.metadata), items = list(rec(subscription.items).data), item = items[0] || {}, price = rec(item.price), recurring = rec(price.recurring);
  const priceMatches = items.length === 1 && Number(item.quantity) === 1 && price.currency === "brl" && Number(price.unit_amount) === Number(attempt.amount_cents) && recurring.interval === (attempt.period === "annual" ? "year" : "month") && Number(recurring.interval_count || 1) === 1;
  const bindingMatches = reference(subscription.customer) === customerId && attempt.provider_customer_id === customerId && metadata.userId === attempt.user_id && metadata.planId === attempt.plan_id && metadata.checkoutId === attempt.id;
  if (!bindingMatches) throw new BillingError(400, "A assinatura não corresponde ao cadastro de cobrança esperado.");
  return { priceMatches, periodEnd: iso(item.current_period_end || subscription.current_period_end), metadata };
}

async function paymentStatements(db: D1Database, config: BillingConfig, invoice: Row, subscription: Row, attempt: Row, lock: BillingLock, fetcher: typeof fetch): Promise<D1PreparedStatement[]> {
  if (reference(invoice.customer) !== reference(subscription.customer) || invoice.currency !== "brl" || subscriptionForInvoice(invoice) !== subscription.id) throw new BillingError(400, "A fatura não corresponde à assinatura verificada.");
  const statements: D1PreparedStatement[] = [];
  const invoiceId = String(invoice.id), pendingKey = `invoice:${invoiceId}`;
  const mode = billingLiveMode(config) ? 1 : 0;
  const localSubscriptionId = `${mode ? "live" : "test"}:${subscription.id}`;
  // Fetch the actual invoice payment records. Credits and out-of-band settlements are not fabricated cash receipts.
  let cursor = "", pages = 0;
  const paymentRows: Row[] = [];
  do {
    const page = await stripeRequest(config, `/v1/invoice_payments?invoice=${stripeId(invoiceId)}&limit=100${cursor ? `&starting_after=${stripeId(cursor)}` : ""}`, undefined, undefined, fetcher);
    const records = list(page.data); paymentRows.push(...records);
    cursor = page.has_more && records.length ? String(records.at(-1)!.id) : "";
    if (++pages >= 10 && cursor) throw new BillingError(503, "A conciliação desta fatura precisa de uma nova tentativa.");
  } while (cursor);
  for (const payment of paymentRows) {
    const intentId = reference(rec(payment.payment).payment_intent);
    if (payment.status !== "paid" || rec(payment.payment).type !== "payment_intent" || !intentId) continue;
    const intent = await stripeRequest(config, `/v1/payment_intents/${stripeId(intentId)}?expand[]=latest_charge`, undefined, undefined, fetcher);
    if (intent.status !== "succeeded" || intent.currency !== "brl" || reference(intent.customer) !== reference(subscription.customer)) continue;
    const gross = Math.min(Number(payment.amount_paid || 0), Number(intent.amount_received || 0));
    if (gross <= 0) continue;
    const charge = rec(intent.latest_charge);
    const refund = Math.min(gross, Math.round(gross * Number(charge.amount_refunded || 0) / Math.max(1, Number(intent.amount_received))));
    const amount = (gross - refund) / 100;
    const key = `${intentId}:${invoiceId}`;
    statements.push(db.prepare("INSERT INTO payments (id, user_id, subscription_id, provider_payment_id, provider_invoice_id, amount, refunded_amount, status, paid_at, created_at, sync_revision, livemode) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE " + fence + " ON CONFLICT(provider_payment_id, livemode) DO UPDATE SET amount = excluded.amount, refunded_amount = excluded.refunded_amount, status = excluded.status, paid_at = excluded.paid_at, sync_revision = excluded.sync_revision WHERE payments.sync_revision <= excluded.sync_revision AND payments.user_id = excluded.user_id").bind(crypto.randomUUID(), String(attempt.user_id), localSubscriptionId, key, invoiceId, amount, refund / 100, amount > 0 ? "paid" : "refunded", iso(rec(payment.status_transitions).paid_at || intent.created), iso(intent.created), lock.revision, mode, ...fenceValues(lock)));
  }
  if (invoice.status === "open" && Number(invoice.amount_remaining) > 0) {
    statements.push(db.prepare("INSERT INTO payments (id, user_id, subscription_id, provider_payment_id, provider_invoice_id, amount, status, sync_revision, livemode) SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE " + fence + " ON CONFLICT(provider_payment_id, livemode) DO UPDATE SET amount = excluded.amount, status = excluded.status, sync_revision = excluded.sync_revision WHERE payments.sync_revision <= excluded.sync_revision").bind(crypto.randomUUID(), String(attempt.user_id), localSubscriptionId, pendingKey, invoiceId, Number(invoice.amount_remaining) / 100, lock.revision, mode, ...fenceValues(lock)));
  } else statements.push(db.prepare("DELETE FROM payments WHERE provider_payment_id = ? AND user_id = ? AND livemode = ? AND " + fence).bind(pendingKey, String(attempt.user_id), mode, ...fenceValues(lock)));
  return statements;
}

const handledEvents = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed", "invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.finalized", "invoice.voided", "invoice.marked_uncollectible", "charge.refunded"]);
export async function processStripeEvent(db: D1Database, config: BillingConfig, event: StripeEvent, fetcher: typeof fetch = fetch): Promise<{ received: true; duplicate?: true; ignored?: true }> {
  if (event.livemode !== Boolean(config.STRIPE_SECRET_KEY?.startsWith("sk_live_"))) throw new BillingError(400, "O modo do evento não corresponde à configuração de cobrança.");
  const mode = event.livemode ? 1 : 0;
  const eventKey = `${mode ? "live" : "test"}:${event.id}`;
  const eventToken = crypto.randomUUID();
  const claim = await db.prepare("INSERT INTO billing_webhook_events (id, type, resource_id, status, token, lease_until, attempts, livemode) VALUES (?, ?, ?, 'processing', ?, unixepoch()+120, 1, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until, status = 'processing', attempts = billing_webhook_events.attempts + 1 WHERE billing_webhook_events.status <> 'processed' AND (billing_webhook_events.status IN ('pending','failed') OR billing_webhook_events.lease_until <= unixepoch())").bind(eventKey, event.type, event.data.object.id, eventToken, mode).run();
  if (!claim.meta.changes) {
    const prior = await one(db, "SELECT status FROM billing_webhook_events WHERE id = ?", eventKey);
    if (prior?.status === "processed") return { received: true, duplicate: true };
    throw new BillingError(503, "Este evento já está em processamento. Repita a entrega.");
  }
  let lock: BillingLock | undefined;
  const markIgnored = async () => {
    await db.prepare("UPDATE billing_webhook_events SET status = 'processed', processed_at = CURRENT_TIMESTAMP, lease_until = 0 WHERE id = ? AND token = ?").bind(eventKey, eventToken).run();
    return { received: true, ignored: true } as const;
  };
  try {
    if (!handledEvents.has(event.type)) return await markIgnored();
    let subscriptionId = "", invoiceId = "", session: Row | null = null;
    const resourceId = event.data.object.id;
    if (event.type.startsWith("customer.subscription.")) subscriptionId = resourceId;
    else if (event.type.startsWith("checkout.session.")) {
      session = await stripeRequest<Row>(config, `/v1/checkout/sessions/${stripeId(resourceId)}`, undefined, undefined, fetcher);
      subscriptionId = reference(session.subscription);
      if (!subscriptionId) {
        if (session.status === "expired") {
          const meta = rec(session.metadata);
          await db.prepare("UPDATE billing_checkouts SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND provider_session_id = ? AND livemode = ?").bind(String(meta.checkoutId || ""), String(meta.userId || ""), resourceId, mode).run();
        }
        return await markIgnored();
      }
    } else if (event.type.startsWith("invoice.")) {
      invoiceId = resourceId;
      const invoice = await stripeRequest(config, `/v1/invoices/${stripeId(invoiceId)}`, undefined, undefined, fetcher);
      subscriptionId = subscriptionForInvoice(invoice);
    } else if (event.type === "charge.refunded") {
      const charge = await stripeRequest(config, `/v1/charges/${stripeId(resourceId)}`, undefined, undefined, fetcher);
      const intentPrefix = `${reference(charge.payment_intent)}:`;
      const payment = await one(db, "SELECT p.provider_invoice_id, s.provider_subscription_id FROM payments p JOIN subscriptions s ON s.id = p.subscription_id WHERE substr(p.provider_payment_id, 1, length(?)) = ? AND p.livemode = ? LIMIT 1", intentPrefix, intentPrefix, mode);
      if (!payment) throw new BillingError(503, "A fatura deste estorno ainda precisa ser conciliada.");
      invoiceId = String(payment.provider_invoice_id); subscriptionId = String(payment.provider_subscription_id);
    }
    if (!subscriptionId) return await markIgnored();
    lock = await acquireBillingLock(db, `subscription:${mode}:${subscriptionId}`);
    // Event snapshots and event.created are deliberately not used as ordering authorities.
    const subscription = await stripeRequest(config, `/v1/subscriptions/${stripeId(subscriptionId)}`, undefined, undefined, fetcher);
    if (subscription.id !== subscriptionId) throw new BillingError(502, "A assinatura retornada pelo provedor é inválida.");
    const metadata = rec(subscription.metadata);
    if (!metadata.checkoutId || !metadata.userId || !metadata.planId) return await markIgnored();
    const attempt = await one(db, "SELECT * FROM billing_checkouts WHERE id = ? AND user_id = ? AND plan_id = ? AND livemode = ?", String(metadata.checkoutId), String(metadata.userId), String(metadata.planId), mode);
    if (!attempt) return await markIgnored();
    const customer = await one(db, "SELECT provider_customer_id FROM billing_customers WHERE user_id = ? AND livemode = ?", String(attempt.user_id), mode);
    if (!customer) return await markIgnored();
    const verified = validateSubscription(subscription, attempt, String(customer.provider_customer_id));
    if (session && (rec(session.metadata).checkoutId !== attempt.id || reference(session.customer) !== customer.provider_customer_id)) throw new BillingError(400, "A sessão de contratação não corresponde à assinatura.");
    const status = verified.priceMatches ? String(subscription.status) : "unverified_price";
    const actual = list(rec(subscription.items).data)[0] || {};
    const price = rec(actual.price);
    const statements: D1PreparedStatement[] = [
      db.prepare("INSERT INTO subscriptions (id, user_id, plan_id, provider, provider_subscription_id, status, amount, period, current_period_end, verified_at, provider_customer_id, checkout_id, cancel_at_period_end, sync_revision, livemode) SELECT ?, ?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE " + fence + " ON CONFLICT(provider_subscription_id, livemode) DO UPDATE SET status = excluded.status, amount = excluded.amount, period = excluded.period, current_period_end = excluded.current_period_end, verified_at = excluded.verified_at, cancel_at_period_end = excluded.cancel_at_period_end, sync_revision = excluded.sync_revision, updated_at = CURRENT_TIMESTAMP WHERE subscriptions.sync_revision <= excluded.sync_revision AND subscriptions.user_id = excluded.user_id AND subscriptions.plan_id = excluded.plan_id").bind(`${mode ? "live" : "test"}:${subscriptionId}`, String(attempt.user_id), String(attempt.plan_id), subscriptionId, status, Number(price.unit_amount ?? attempt.amount_cents) / 100, String(attempt.period), verified.periodEnd, verified.priceMatches ? new Date().toISOString() : null, String(customer.provider_customer_id), String(attempt.id), subscription.cancel_at_period_end ? 1 : 0, lock.revision, mode, ...fenceValues(lock)),
      db.prepare("UPDATE billing_checkouts SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND " + fence).bind(String(attempt.id), String(attempt.user_id), ...fenceValues(lock)),
    ];
    if (subscription.trial_start) statements.push(db.prepare("UPDATE billing_customers SET trial_used = 1 WHERE user_id = ? AND livemode = ? AND " + fence).bind(String(attempt.user_id), mode, ...fenceValues(lock)));
    if (invoiceId) {
      const invoice = await stripeRequest(config, `/v1/invoices/${stripeId(invoiceId)}`, undefined, undefined, fetcher);
      statements.push(...await paymentStatements(db, config, invoice, subscription, attempt, lock, fetcher));
    }
    const message = !verified.priceMatches ? "Alteração de preço sem correspondência com a contratação; acesso pago bloqueado para revisão" : event.type === "invoice.payment_failed" ? "O provedor informou uma tentativa de cobrança não concluída" : "Estado de cobrança conciliado com o provedor";
    statements.push(db.prepare("INSERT INTO events (id, type, user_id, message) SELECT ?, ?, ?, ? WHERE " + fence + " ON CONFLICT(id) DO NOTHING").bind(`stripe:${eventKey}`, !verified.priceMatches ? "billing_review" : event.type === "invoice.payment_failed" ? "payment_failure" : "billing_sync", String(attempt.user_id), `${mode ? "" : "Stripe teste: "}${message}`, ...fenceValues(lock)));
    statements.push(db.prepare("UPDATE billing_webhook_events SET status = 'processed', processed_at = CURRENT_TIMESTAMP, lease_until = 0 WHERE id = ? AND token = ? AND " + fence).bind(eventKey, eventToken, ...fenceValues(lock)));
    const outcome = await db.batch(statements);
    if (!outcome.at(-1)?.meta.changes) throw new BillingError(503, "A atualização perdeu sua reserva e será repetida com o estado mais recente.");
    return { received: true };
  } catch (error) {
    await db.prepare("UPDATE billing_webhook_events SET status = 'failed', lease_until = 0 WHERE id = ? AND token = ? AND status <> 'processed'").bind(eventKey, eventToken).run();
    throw error;
  } finally { if (lock) await releaseBillingLock(db, lock); }
}
