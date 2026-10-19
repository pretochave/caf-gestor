import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = () => ({
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull(),
  phone: text("phone").notNull().default(""), city: text("city").notNull().default(""),
  state: text("state").notNull().default(""), company: text("company").notNull().default(""),
  status: text("status").notNull().default("active"),
  lastAccess: text("last_access").notNull().default(sql`CURRENT_TIMESTAMP`), ...timestamps(),
}, (t) => [index("profiles_email_idx").on(t.email), check("profiles_status_check", sql`${t.status} IN ('active', 'suspended')`)]);

export const farms = sqliteTable("farms", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" }).notNull(), ...timestamps(),
}, (t) => [index("farms_owner_idx").on(t.ownerId), uniqueIndex("farms_id_owner_unique").on(t.id, t.ownerId)]);

export const plots = sqliteTable("plots", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  farmId: text("farm_id").notNull(), payload: text("payload", { mode: "json" }).notNull(), ...timestamps(),
}, (t) => [index("plots_owner_farm_idx").on(t.ownerId, t.farmId),
  uniqueIndex("plots_id_farm_owner_unique").on(t.id, t.farmId, t.ownerId),
  foreignKey({ columns: [t.farmId, t.ownerId], foreignColumns: [farms.id, farms.ownerId] }).onDelete("cascade"),
]);

export const seasons = sqliteTable("seasons", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" }).notNull(), ...timestamps(),
}, (t) => [index("seasons_owner_idx").on(t.ownerId), uniqueIndex("seasons_id_owner_unique").on(t.id, t.ownerId)]);

const agriculturalColumns = () => ({
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  farmId: text("farm_id").notNull(), plotId: text("plot_id"), seasonId: text("season_id"),
  payload: text("payload", { mode: "json" }).notNull(), ...timestamps(),
});

export const expenses = sqliteTable("expenses", agriculturalColumns(), (t) => [
  index("expenses_owner_farm_idx").on(t.ownerId, t.farmId),
  foreignKey({ columns: [t.farmId, t.ownerId], foreignColumns: [farms.id, farms.ownerId] }).onDelete("cascade"),
  foreignKey({ columns: [t.plotId, t.farmId, t.ownerId], foreignColumns: [plots.id, plots.farmId, plots.ownerId] }).onDelete("restrict"),
  foreignKey({ columns: [t.seasonId, t.ownerId], foreignColumns: [seasons.id, seasons.ownerId] }).onDelete("restrict"),
]);
export const productions = sqliteTable("productions", agriculturalColumns(), (t) => [
  index("productions_owner_farm_idx").on(t.ownerId, t.farmId),
  foreignKey({ columns: [t.farmId, t.ownerId], foreignColumns: [farms.id, farms.ownerId] }).onDelete("cascade"),
  foreignKey({ columns: [t.plotId, t.farmId, t.ownerId], foreignColumns: [plots.id, plots.farmId, plots.ownerId] }).onDelete("restrict"),
  foreignKey({ columns: [t.seasonId, t.ownerId], foreignColumns: [seasons.id, seasons.ownerId] }).onDelete("restrict"),
]);
export const revenues = sqliteTable("revenues", agriculturalColumns(), (t) => [
  index("revenues_owner_farm_idx").on(t.ownerId, t.farmId),
  foreignKey({ columns: [t.farmId, t.ownerId], foreignColumns: [farms.id, farms.ownerId] }).onDelete("cascade"),
  foreignKey({ columns: [t.seasonId, t.ownerId], foreignColumns: [seasons.id, seasons.ownerId] }).onDelete("restrict"),
]);

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(), payload: text("payload", { mode: "json" }).notNull(), ...timestamps(),
});

// Only verified provider events may write subscription and payment state.
export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "restrict" }),
  provider: text("provider").notNull().default("stripe"), providerSubscriptionId: text("provider_subscription_id").notNull(),
  status: text("status").notNull(), amount: real("amount").notNull(), period: text("period").notNull().default("monthly"),
  currentPeriodEnd: text("current_period_end").notNull(), verifiedAt: text("verified_at"), ...timestamps(),
  providerCustomerId: text("provider_customer_id"), checkoutId: text("checkout_id"),
  cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull().default(false),
  syncRevision: integer("sync_revision").notNull().default(0),
  livemode: integer("livemode", { mode: "boolean" }).notNull().default(true),
}, (t) => [index("subscriptions_user_idx").on(t.userId), uniqueIndex("subscriptions_provider_mode_unique").on(t.providerSubscriptionId, t.livemode), check("subscriptions_amount_check", sql`${t.amount} >= 0`)]);
export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  subscriptionId: text("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
  providerPaymentId: text("provider_payment_id").notNull(), amount: real("amount").notNull(), status: text("status").notNull(),
  paidAt: text("paid_at"), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  providerInvoiceId: text("provider_invoice_id"), refundedAmount: real("refunded_amount").notNull().default(0),
  syncRevision: integer("sync_revision").notNull().default(0),
  livemode: integer("livemode", { mode: "boolean" }).notNull().default(true),
}, (t) => [index("payments_user_idx").on(t.userId), uniqueIndex("payments_provider_mode_unique").on(t.providerPaymentId, t.livemode), check("payments_amount_check", sql`${t.amount} >= 0`)]);
export const crm = sqliteTable("crm", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().unique().references(() => profiles.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" }).notNull(), ...timestamps(),
});
export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(), payload: text("payload", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [index("contacts_user_idx").on(t.userId)]);
export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  payload: text("payload", { mode: "json" }).notNull(), ...timestamps(),
}, (t) => [index("tickets_owner_idx").on(t.ownerId)]);
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(), payload: text("payload", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
export const audit = sqliteTable("audit", {
  id: text("id").primaryKey(), actorId: text("actor_id").notNull(), action: text("action").notNull(),
  entity: text("entity").notNull(), targetId: text("target_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [index("audit_created_idx").on(t.createdAt)]);
export const events = sqliteTable("events", {
  id: text("id").primaryKey(), type: text("type").notNull(), userId: text("user_id"), message: text("message").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [index("events_created_idx").on(t.createdAt)]);

export const billingCustomers = sqliteTable("billing_customers", {
  userId: text("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  providerCustomerId: text("provider_customer_id").notNull(),
  livemode: integer("livemode", { mode: "boolean" }).notNull().default(true),
  trialUsed: integer("trial_used", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [primaryKey({ columns: [t.userId, t.livemode] }), uniqueIndex("billing_customers_provider_mode_unique").on(t.providerCustomerId, t.livemode)]);
// Immutable quotation. Editing a public plan never changes a previously accepted price.
export const billingCheckouts = sqliteTable("billing_checkouts", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().references(() => plans.id, { onDelete: "restrict" }),
  amountCents: integer("amount_cents").notNull(), period: text("period").notNull(),
  planSnapshot: text("plan_snapshot", { mode: "json" }).notNull(),
  providerCustomerId: text("provider_customer_id"), providerSessionId: text("provider_session_id"),
  checkoutUrl: text("checkout_url"), status: text("status").notNull().default("creating"),
  expiresAt: integer("expires_at").notNull(), ...timestamps(),
  livemode: integer("livemode", { mode: "boolean" }).notNull().default(true),
}, (t) => [index("billing_checkouts_user_idx").on(t.userId), uniqueIndex("billing_checkouts_session_mode_unique").on(t.providerSessionId, t.livemode), check("billing_checkouts_amount_check", sql`${t.amountCents} > 0`)]);
// Retain IDs and processing outcome rather than full webhook payloads containing personal data.
export const billingWebhookEvents = sqliteTable("billing_webhook_events", {
  id: text("id").primaryKey(), type: text("type").notNull(), resourceId: text("resource_id").notNull(),
  status: text("status").notNull().default("pending"), token: text("token"), leaseUntil: integer("lease_until").notNull().default(0),
  attempts: integer("attempts").notNull().default(0), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  processedAt: text("processed_at"),
  livemode: integer("livemode", { mode: "boolean" }).notNull().default(true),
});
// Provider retrieval occurs only after acquiring this lease. Revision fences expired workers.
export const billingLocks = sqliteTable("billing_locks", {
  resourceId: text("resource_id").primaryKey(), token: text("token").notNull(),
  expiresAt: integer("expires_at").notNull(), revision: integer("revision").notNull().default(1),
});
