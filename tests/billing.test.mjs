import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { acquireBillingLock, releaseBillingLock, billingLiveMode, billingStatus, billingReturnUrl, createCheckout, processStripeEvent, verifyStripeSignature } from "../lib/billing.ts";

const configuration = { STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture", SITE_URL: "https://cafegestor.example" };
const profile = { id: "a", name: "Ana", email: "ana@example.com", role: "producer", plan: "free", status: "active" };
const plan = { id: "pro", name: "Pro", price: 49.9, period: "monthly", active: true, visible: true, farmLimit: 5, plotLimit: 50, trialDays: 0, order: 1, benefits: [], features: { export: true, simulator: true, reports: true, advanced: true } };
function fixture() {
  const native = new DatabaseSync(":memory:"); native.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(directory).filter((n) => n.endsWith(".sql")).sort()) native.exec(readFileSync(new URL(name, directory), "utf8"));
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    async first() { return native.prepare(this.sql).get(...this.values) || null; }
    async all() { return { results: native.prepare(this.sql).all(...this.values) }; }
    async run() { const result = native.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
  }
  const db = { prepare: (sql) => new Statement(sql), async batch(statements) { native.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); native.exec("COMMIT"); return results; } catch (error) { native.exec("ROLLBACK"); throw error; } } };
  native.prepare("INSERT INTO profiles(id,name,email) VALUES(?,?,?)").run(profile.id, profile.name, profile.email);
  native.prepare("INSERT INTO plans(id,payload) VALUES(?,?)").run(plan.id, JSON.stringify(plan));
  native.exec("INSERT INTO billing_customers(user_id,provider_customer_id,livemode) VALUES('a','cus_a',0)");
  const seedAttempt = () => native.prepare("INSERT INTO billing_checkouts(id,user_id,plan_id,amount_cents,period,plan_snapshot,provider_customer_id,expires_at,livemode) VALUES('attempt','a','pro',4990,'monthly',?,'cus_a',unixepoch()+3600,0)").run(JSON.stringify(plan));
  const state = {
    subscription: { id: "sub_a", object: "subscription", customer: "cus_a", status: "active", cancel_at_period_end: false, metadata: { userId: "a", planId: "pro", checkoutId: "attempt" }, items: { data: [{ quantity: 1, current_period_end: Math.floor(Date.now()/1000)+86400, price: { unit_amount: 4990, currency: "brl", recurring: { interval: "month", interval_count: 1 } } }] } },
    invoice: { id: "in_a", customer: "cus_a", currency: "brl", parent: { subscription_details: { subscription: "sub_a" } }, status: "paid", amount_remaining: 0 },
    paymentRows: [{ id: "inpay_a", status: "paid", amount_paid: 4990, payment: { type: "payment_intent", payment_intent: "pi_a" }, status_transitions: { paid_at: 1792425600 } }],
    intent: { id: "pi_a", customer: "cus_a", currency: "brl", status: "succeeded", amount_received: 4990, created: 1792425600, latest_charge: { id: "ch_a", amount_refunded: 0 } },
    requests: [],
  };
  const fetcher = async (url, init = {}) => {
    state.requests.push({ url: String(url), init });
    const parsed = new URL(url), path = parsed.pathname;
    let response;
    if (path === "/v1/subscriptions/sub_a") response = state.subscription;
    else if (path === "/v1/subscriptions") response = { data: [], has_more: false };
    else if (path === "/v1/checkout/sessions" || path === "/v1/checkout/sessions/cs_test_a") response = { id: "cs_test_a", status: "open", url: "https://checkout.stripe.com/c/pay/cs_test_a" };
    else if (path === "/v1/invoices/in_a") response = state.invoice;
    else if (path === "/v1/invoice_payments") response = { data: state.paymentRows, has_more: false };
    else if (path === "/v1/payment_intents/pi_a") response = state.intent;
    else if (path === "/v1/charges/ch_a") response = { id: "ch_a", payment_intent: "pi_a" };
    else throw new Error("Unexpected fixture request " + url);
    return Response.json(response);
  };
  const event = (id, type = "customer.subscription.updated", objectId = "sub_a", created = 100) => ({ id, type, created, livemode: false, data: { object: { id: objectId } } });
  return { native, db, state, seedAttempt, fetcher, event };
}
async function sign(raw, timestamp, secret = configuration.STRIPE_WEBHOOK_SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${raw}`)));
  return Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
}
test("Stripe HMAC authenticates original bytes, rotation signatures and timestamp tolerance", async () => {
  const raw = '{"message":"café"}\r\n', timestamp = 1792425600, digest = await sign(raw, timestamp);
  assert.equal(await verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, configuration.STRIPE_WEBHOOK_SECRET, timestamp), true);
  assert.equal(await verifyStripeSignature(raw, `t=${timestamp},v1=${"0".repeat(64)},v1=${digest}`, configuration.STRIPE_WEBHOOK_SECRET, timestamp), true);
  assert.equal(await verifyStripeSignature(raw.trim(), `t=${timestamp},v1=${digest}`, configuration.STRIPE_WEBHOOK_SECRET, timestamp), false);
  assert.equal(await verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, "whsec_wrong", timestamp), false);
  assert.equal(await verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, configuration.STRIPE_WEBHOOK_SECRET, timestamp+301), false);
  assert.equal(await verifyStripeSignature(raw, `t=${timestamp},v1=${digest}`, configuration.STRIPE_WEBHOOK_SECRET, timestamp-301), false);
  assert.equal(await verifyStripeSignature(raw, `t=${timestamp},v0=${digest}`, configuration.STRIPE_WEBHOOK_SECRET, timestamp), false);
  assert.equal(await verifyStripeSignature(raw, `t=${timestamp},t=${timestamp},v1=${digest}`, configuration.STRIPE_WEBHOOK_SECRET, timestamp), false);
});
test("billing configuration and return URLs never trust client origins or expose secrets", () => {
  assert.equal(billingStatus(configuration).configured, true);
  assert.equal(billingStatus({}).configured, false);
  assert.deepEqual(billingStatus({}).missing, ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SITE_URL"]);
  assert.equal(JSON.stringify(billingStatus(configuration)).includes("fixture"), false);
  assert.equal(billingReturnUrl(configuration, "/assinatura?billing=success"), "https://cafegestor.example/assinatura?billing=success");
  assert.throws(() => billingReturnUrl(configuration, "//attacker.example"), { status: 400 });
  assert.throws(() => billingReturnUrl(configuration, "/\\attacker.example"), { status: 400 });
  assert.equal(billingStatus({ ...configuration, SITE_URL: "http://public.example" }).configured, false);
});
test("checkout uses immutable server price, reuses session and grants no access", async () => {
  const f = fixture();
  const first = await createCheckout(f.db, configuration, profile, plan, "monthly", f.fetcher);
  const second = await createCheckout(f.db, configuration, profile, plan, "monthly", f.fetcher);
  assert.equal(first.url, second.url);
  const creates = f.state.requests.filter((r) => new URL(r.url).pathname === "/v1/checkout/sessions");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].init.body.get("line_items[0][price_data][unit_amount]"), "4990");
  assert.equal(creates[0].init.body.get("subscription_data[metadata][userId]"), "a");
  assert.ok(creates[0].init.headers["Idempotency-Key"]);
  assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM subscriptions").get().n, 0);
  await assert.rejects(createCheckout(f.db, configuration, profile, { ...plan, price: 0 }, undefined, f.fetcher), { status: 400 });
  f.native.close();
});
test("verified subscription events are idempotent and use fetched current state regardless of event order", async () => {
  const f = fixture(); f.seedAttempt();
  await processStripeEvent(f.db, configuration, f.event("evt_new", undefined, undefined, 200), f.fetcher);
  assert.equal(f.native.prepare("SELECT status FROM subscriptions").get().status, "active");
  const count = f.state.requests.length;
  assert.deepEqual(await processStripeEvent(f.db, configuration, f.event("evt_new"), f.fetcher), { received: true, duplicate: true });
  assert.equal(f.state.requests.length, count);
  f.state.subscription.status = "canceled";
  await processStripeEvent(f.db, configuration, f.event("evt_older", undefined, undefined, 10), f.fetcher);
  assert.equal(f.native.prepare("SELECT status FROM subscriptions").get().status, "canceled");
  assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM billing_webhook_events WHERE status='processed'").get().n, 2);
  f.native.close();
});
test("editing public price preserves contract snapshot; an unrecognized Stripe price cannot grant premium", async () => {
  const f = fixture(); f.seedAttempt();
  f.native.prepare("UPDATE plans SET payload=? WHERE id='pro'").run(JSON.stringify({ ...plan, price: 99.9 }));
  await processStripeEvent(f.db, configuration, f.event("evt_snapshot"), f.fetcher);
  assert.equal(f.native.prepare("SELECT amount FROM subscriptions").get().amount, 49.9);
  f.state.subscription.items.data[0].price.unit_amount = 9990;
  await processStripeEvent(f.db, configuration, f.event("evt_unrecognized"), f.fetcher);
  const row = f.native.prepare("SELECT status,verified_at FROM subscriptions").get();
  assert.equal(row.status, "unverified_price"); assert.equal(row.verified_at, null);
  f.native.close();
});
test("lease revisions fence stale workers before writes and retain retryable event", async () => {
  const f = fixture(); f.seedAttempt();
  const fetcher = async (...args) => {
    const response = await f.fetcher(...args);
    f.native.exec("UPDATE billing_locks SET token='new-owner',revision=revision+1,expires_at=unixepoch()+120 WHERE resource_id='subscription:0:sub_a'");
    return response;
  };
  await assert.rejects(processStripeEvent(f.db, configuration, f.event("evt_stale"), fetcher), { status: 503 });
  assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM subscriptions").get().n, 0);
  assert.equal(f.native.prepare("SELECT status FROM billing_webhook_events").get().status, "failed");
  assert.equal(f.native.prepare("SELECT token FROM billing_locks").get().token, "new-owner");
  f.native.close();
});
test("invoice reconciliation stores actual Stripe receipts once and reflects refunds", async () => {
  const f = fixture(); f.seedAttempt();
  await processStripeEvent(f.db, configuration, f.event("evt_paid", "invoice.paid", "in_a"), f.fetcher);
  await processStripeEvent(f.db, configuration, f.event("evt_paid2", "invoice.payment_succeeded", "in_a"), f.fetcher);
  let row = f.native.prepare("SELECT amount,status FROM payments").get();
  assert.equal(row.amount, 49.9); assert.equal(row.status, "paid");
  assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM payments").get().n, 1);
  f.state.intent.latest_charge.amount_refunded = 4990;
  await processStripeEvent(f.db, configuration, f.event("evt_refund", "charge.refunded", "ch_a"), f.fetcher);
  row = f.native.prepare("SELECT amount,status,refunded_amount FROM payments").get();
  assert.equal(row.amount, 0); assert.equal(row.status, "refunded"); assert.equal(row.refunded_amount, 49.9);
  f.native.close();
});
test("credits or out-of-band settled invoices do not create fabricated cash receipts", async () => {
  const f = fixture(); f.seedAttempt(); f.state.paymentRows = [];
  await processStripeEvent(f.db, configuration, f.event("evt_credit", "invoice.paid", "in_a"), f.fetcher);
  assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM payments").get().n, 0);
  f.native.close();
});
test("resource lease serializes processing and preserves monotonically increasing revisions", async () => {
  const f = fixture();
  const first = await acquireBillingLock(f.db, "subscription:test");
  await assert.rejects(acquireBillingLock(f.db, "subscription:test"), { status: 503 });
  await releaseBillingLock(f.db, first);
  const second = await acquireBillingLock(f.db, "subscription:test");
  assert.ok(second.revision > first.revision);
  f.native.close();
});
test("switching from test to live excludes test entitlements, cash and customer mappings", async () => {
  const f = fixture(); f.seedAttempt();
  await processStripeEvent(f.db, configuration, f.event("evt_testcash", "invoice.paid", "in_a"), f.fetcher);
  const production = { ...configuration, STRIPE_SECRET_KEY: "sk_live_fixture" };
  assert.equal(billingLiveMode(configuration), false);
  assert.equal(billingLiveMode(production), true);
  assert.equal(billingLiveMode({}), true);
  const mode = billingLiveMode(production) ? 1 : 0;
  assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id=? AND livemode=? AND status='active' AND verified_at IS NOT NULL").get("a", mode).n, 0);
  assert.equal(f.native.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM payments WHERE livemode=? AND status='paid'").get(mode).amount, 0);
  assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM billing_customers WHERE user_id=? AND livemode=?").get("a", mode).n, 0);
  await assert.rejects(processStripeEvent(f.db, production, f.event("evt_testwrong"), f.fetcher), { status: 400 });
  f.native.close();
});
