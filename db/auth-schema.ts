import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Native accounts have their own durable ID. Email alone never links an old tenant.
export const authUsers = sqliteTable("auth_users", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false), image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(), expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(), ipAddress: text("ip_address"), userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
}, (t) => [index("auth_sessions_user_idx").on(t.userId)]);
export const authAccounts = sqliteTable("auth_accounts", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull(), providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }), scope: text("scope"), password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [index("auth_accounts_user_idx").on(t.userId)]);
export const authVerifications = sqliteTable("auth_verifications", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [index("auth_verifications_identifier_idx").on(t.identifier)]);
// Persistent limits are shared by every Worker, not reset by deployment or restart.
export const authRequestLimits = sqliteTable("auth_request_limits", {
  key: text("key").primaryKey(), count: integer("count").notNull(), windowStart: integer("window_start").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [index("auth_limits_expiry_idx").on(t.expiresAt)]);
export const authMailCooldowns = sqliteTable("auth_mail_cooldowns", {
  key: text("key").primaryKey(), lastSentAt: integer("last_sent_at").notNull(),
}, (t) => [index("auth_mail_sent_idx").on(t.lastSentAt)]);
export const authOperationLocks = sqliteTable("auth_operation_locks", {
  key: text("key").primaryKey(), token: text("token").notNull(), expiresAt: integer("expires_at").notNull(),
}, (t) => [index("auth_locks_expiry_idx").on(t.expiresAt)]);
