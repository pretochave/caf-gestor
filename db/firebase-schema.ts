import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// A session belongs to a Firebase project and UID, never to an email match.
export const firebaseSessions = sqliteTable("firebase_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  ownerId: text("owner_id").notNull(),
  projectId: text("project_id").notNull(),
  uid: text("uid").notNull(),
  email: text("email").notNull(),
  kind: text("kind").notNull(),
  encryptedTokens: text("encrypted_tokens").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("firebase_sessions_owner_idx").on(table.ownerId), index("firebase_sessions_email_idx").on(table.email), index("firebase_sessions_expiry_idx").on(table.expiresAt)]);
