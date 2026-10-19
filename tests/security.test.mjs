import test from "node:test";
import assert from "node:assert/strict";
import { isAdmin, assertOwner, activeSubscription, requireFeature, assertSameOrigin, entitySchemas, mutationSchema } from "../lib/security.ts";

test("admin requires one explicitly configured email, normalized case", () => {
  assert.equal(isAdmin("owner@example.com", undefined), false);
  assert.equal(isAdmin("owner@example.com", ""), false);
  assert.equal(isAdmin("Owner@Example.com", " owner@example.COM "), true);
  assert.equal(isAdmin("owner@example.com.attacker.test", "owner@example.com"), false);
  assert.equal(isAdmin("other@example.com", "owner@example.com"), false);
});
test("tenant ownership denies absent and other-user records", () => {
  assert.doesNotThrow(() => assertOwner("a", "a"));
  assert.throws(() => assertOwner("a", "b"), { status: 404 });
  assert.throws(() => assertOwner(undefined, "b"), { status: 404 });
});
test("premium requires a verified, unexpired active provider subscription", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const s = { id: "s", status: "active", verifiedAt: "2026-10-19T10:00:00Z", currentPeriodEnd: "2026-11-19T12:00:00Z", planId: "pro" };
  assert.equal(activeSubscription([s], now)?.planId, "pro");
  assert.equal(activeSubscription([{ ...s, verifiedAt: null }], now), null);
  assert.equal(activeSubscription([{ ...s, status: "past_due" }], now), null);
  assert.equal(activeSubscription([{ ...s, status: "canceled" }], now), null);
  assert.equal(activeSubscription([{ ...s, currentPeriodEnd: "2026-10-01T12:00:00Z" }], now), null);
  assert.equal(activeSubscription([{ ...s, currentPeriodEnd: "invalid" }], now), null);
});
test("server feature gates deny exports and simulator on free plans", () => {
  const plan = { features: { export: false, simulator: false, reports: false, advanced: false } };
  assert.throws(() => requireFeature(plan, "export"), { status: 403 });
  assert.throws(() => requireFeature(plan, "simulator"), { status: 403 });
  assert.doesNotThrow(() => requireFeature({ features: { export: true } }, "export"));
});
test("cross-site writes and non-JSON requests are rejected", () => {
  const create = (headers) => new Request("https://cafegestor.example/api/data", { method: "POST", headers });
  assert.throws(() => assertSameOrigin(create({ "content-type": "application/json", origin: "https://evil.example" })), { status: 403 });
  assert.throws(() => assertSameOrigin(create({ "content-type": "application/json", "sec-fetch-site": "cross-site" })), { status: 403 });
  assert.throws(() => assertSameOrigin(create({ "content-type": "text/plain" })), { status: 415 });
  assert.doesNotThrow(() => assertSameOrigin(create({ "content-type": "application/json", origin: "https://cafegestor.example" })));
});
test("client cannot grant role, plan, owner or fake subscription state", () => {
  assert.equal(entitySchemas.profile.safeParse({ name: "Ana", role: "admin" }).success, false);
  assert.equal(entitySchemas.profile.safeParse({ name: "Ana", plan: "premium" }).success, false);
  assert.equal(entitySchemas.user.safeParse({ status: "active", role: "admin" }).success, false);
  assert.equal(mutationSchema.safeParse({ entity: "subscription", action: "create", data: { status: "active" } }).success, false);
  assert.equal(entitySchemas.farm.safeParse({ name: "A", totalArea: 1, cultivatedArea: 1, plants: 10, year: 2026, ownerId: "victim" }).success, false);
});
test("business validation rejects invalid dates, negative money and impossible areas", () => {
  const expense = { farmId: "f", category: "Adubação", description: "Adubo", amount: 10, date: "2026-10-19" };
  assert.equal(entitySchemas.expense.safeParse(expense).success, true);
  assert.equal(entitySchemas.expense.safeParse({ ...expense, amount: -1 }).success, false);
  assert.equal(entitySchemas.expense.safeParse({ ...expense, date: "2026-02-30" }).success, false);
  assert.equal(entitySchemas.farm.safeParse({ name: "A", totalArea: 1, cultivatedArea: 2, plants: 10, year: 2026 }).success, false);
  assert.equal(entitySchemas.production.safeParse({ farmId: "f", bags: 10, area: 0, date: "2026-10-19" }).success, false);
});
