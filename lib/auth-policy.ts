export const authPolicies = { otpDigits: 6, otpExpiresIn: 600, otpAllowedAttempts: 5, resendInterval: 60, resetExpiresIn: 1800 } as const;
export type AuthConfig = { AUTH_PROVIDER?: string; FIREBASE_API_KEY?: string; FIREBASE_PROJECT_ID?: string; BETTER_AUTH_SECRET?: string; SITE_URL?: string; RESEND_API_KEY?: string; EMAIL_FROM?: string; ADMIN_EMAIL?: string };
export class NativeAuthError extends Error {
  status: number; code: string; retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
export function authOrigin(config: AuthConfig): string {
  let origin: URL;
  try { origin = new URL(config.SITE_URL || ""); } catch { throw new NativeAuthError(503, "AUTH_NOT_CONFIGURED", "O endereço público da plataforma ainda não foi configurado."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || (origin.protocol !== "https:" && !(loopback && origin.protocol === "http:"))) throw new NativeAuthError(503, "AUTH_NOT_CONFIGURED", "Configure um endereço HTTPS válido para a plataforma.");
  return origin.origin;
}
export function nativeAuthStatus(config: AuthConfig, hasDatabase = true) {
  const missing: string[] = [];
  if (!hasDatabase) missing.push("DB");
  if ((config.BETTER_AUTH_SECRET?.trim().length || 0) < 32) missing.push("BETTER_AUTH_SECRET");
  try { authOrigin(config); } catch { missing.push("SITE_URL"); }
  if (!/^re_[A-Za-z0-9_-]{12,}$/.test(config.RESEND_API_KEY || "")) missing.push("RESEND_API_KEY");
  if (!config.EMAIL_FROM || !/^[^\r\n]+<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$|^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.EMAIL_FROM)) missing.push("EMAIL_FROM");
  return { configured: missing.length === 0, mailConfigured: !missing.includes("RESEND_API_KEY") && !missing.includes("EMAIL_FROM"), missing, policies: authPolicies };
}
export function safeAuthReturnPath(value: string, fallback = "/dashboard"): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try { const parsed = new URL(value, "https://cafegestor.invalid"); if (parsed.origin !== "https://cafegestor.invalid" || parsed.pathname.startsWith("/api/auth")) return fallback; return parsed.pathname + parsed.search + parsed.hash; } catch { return fallback; }
}
export function verifiedAdministrator(email: string, verified: boolean, configuredEmail?: string): boolean {
  return verified === true && Boolean(configuredEmail?.trim()) && email.trim().toLowerCase() === configuredEmail!.trim().toLowerCase();
}
export async function secretDigest(config: AuthConfig, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(config.BETTER_AUTH_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))), (n) => n.toString(16).padStart(2, "0")).join("");
}
export function verificationIdentifier(config: AuthConfig, value: string): Promise<string> {
  return secretDigest(config, `verification-identifier:${value}`);
}
export async function assertMailCooldown(db: D1Database, key: string): Promise<void> {
  const current = await db.prepare("SELECT MAX(1, ? - (unixepoch()-last_sent_at)) AS remaining FROM auth_mail_cooldowns WHERE key=? AND last_sent_at > unixepoch()-?").bind(authPolicies.resendInterval, key, authPolicies.resendInterval).first<{ remaining: number }>();
  if (current) throw new NativeAuthError(429, "TOO_MANY_REQUESTS", "Aguarde 60 segundos antes de pedir outro e-mail.", Number(current.remaining));
}
export async function consumeAuthLimit(db: D1Database, key: string, maximum: number, windowSeconds: number): Promise<void> {
  const result = await db.prepare("INSERT INTO auth_request_limits (key, count, window_start, expires_at) VALUES (?, 1, unixepoch(), unixepoch()+?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN auth_request_limits.window_start <= unixepoch()-? THEN 1 ELSE auth_request_limits.count+1 END, window_start = CASE WHEN auth_request_limits.window_start <= unixepoch()-? THEN unixepoch() ELSE auth_request_limits.window_start END, expires_at = unixepoch()+? WHERE auth_request_limits.window_start <= unixepoch()-? OR auth_request_limits.count < ?").bind(key, windowSeconds, windowSeconds, windowSeconds, windowSeconds, windowSeconds, maximum).run();
  if (!result.meta.changes) throw new NativeAuthError(429, "TOO_MANY_REQUESTS", "Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.", windowSeconds);
}
export async function reserveAuthMail(db: D1Database, key: string): Promise<void> {
  const result = await db.prepare("INSERT INTO auth_mail_cooldowns (key, last_sent_at) VALUES (?, unixepoch()) ON CONFLICT(key) DO UPDATE SET last_sent_at=excluded.last_sent_at WHERE auth_mail_cooldowns.last_sent_at <= unixepoch()-?").bind(key, authPolicies.resendInterval).run();
  if (!result.meta.changes) throw new NativeAuthError(429, "RESEND_COOLDOWN", "Aguarde 60 segundos antes de pedir outro e-mail.", authPolicies.resendInterval);
}
export async function acquireAuthLock(db: D1Database, key: string): Promise<string> {
  const token = crypto.randomUUID();
  const result = await db.prepare("INSERT INTO auth_operation_locks (key, token, expires_at) VALUES (?, ?, unixepoch()+120) ON CONFLICT(key) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at WHERE auth_operation_locks.expires_at <= unixepoch()").bind(key, token).run();
  if (!result.meta.changes) throw new NativeAuthError(429, "AUTH_REQUEST_IN_PROGRESS", "Já existe uma solicitação em andamento. Aguarde um instante.", 2);
  return token;
}
export async function releaseAuthLock(db: D1Database, key: string, token: string): Promise<void> {
  await db.prepare("DELETE FROM auth_operation_locks WHERE key=? AND token=?").bind(key, token).run();
}
export async function cleanupExpiredAuthGuards(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM auth_request_limits WHERE key IN (SELECT key FROM auth_request_limits WHERE expires_at < unixepoch() LIMIT 50)"),
    db.prepare("DELETE FROM auth_operation_locks WHERE key IN (SELECT key FROM auth_operation_locks WHERE expires_at < unixepoch()-120 LIMIT 50)"),
    db.prepare("DELETE FROM auth_mail_cooldowns WHERE key IN (SELECT key FROM auth_mail_cooldowns WHERE last_sent_at < unixepoch()-86400 LIMIT 50)"),
  ]);
}
