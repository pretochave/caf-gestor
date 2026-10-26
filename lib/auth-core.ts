import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { authUsers, authSessions, authAccounts, authVerifications } from "../db/auth-schema";
import { authOrigin, authPolicies, acquireAuthLock, assertMailCooldown, cleanupExpiredAuthGuards, consumeAuthLimit, nativeAuthStatus, NativeAuthError, reserveAuthMail, releaseAuthLock, secretDigest, verificationIdentifier, type AuthConfig } from "./auth-policy";
import { resendMailer, resetMail, verificationMail, type AuthMailer } from "./auth-mail";
export type { AuthConfig } from "./auth-policy";
export type { AuthMail, AuthMailer } from "./auth-mail";
export type CreateAuthOptions = { mailer?: AuthMailer; onDeliveryError?: (error: NativeAuthError) => void };

export function createAuth(config: AuthConfig, db: D1Database, options: CreateAuthOptions = {}) {
  const origin = authOrigin(config);
  if ((config.BETTER_AUTH_SECRET?.trim().length || 0) < 32) throw new NativeAuthError(503, "AUTH_NOT_CONFIGURED", "A autenticação segura ainda não foi configurada.");
  const mailer = options.mailer || resendMailer(config);
  const deliver = async (email: string, kind: string, mail: Parameters<AuthMailer>[0]) => {
    try { await reserveAuthMail(db, await secretDigest(config, `mail:${kind}:${email.toLowerCase()}`)); await mailer(mail); }
    catch (error) { const safe = error instanceof NativeAuthError ? error : new NativeAuthError(503, "EMAIL_DELIVERY_UNAVAILABLE", "Não foi possível enviar o e-mail agora. Aguarde um minuto e tente novamente."); options.onDeliveryError?.(safe); throw safe; }
  };
  return betterAuth({
    appName: "CaféGestor", baseURL: origin, basePath: "/api/auth", secret: config.BETTER_AUTH_SECRET!,
    trustedOrigins: [origin],
    database: drizzleAdapter(drizzle(db), { provider: "sqlite", schema: { user: authUsers, session: authSessions, account: authAccounts, verification: authVerifications }, transaction: false }),
    emailAndPassword: {
      enabled: true, requireEmailVerification: true, minPasswordLength: 10, maxPasswordLength: 128,
      autoSignIn: false, resetPasswordTokenExpiresIn: authPolicies.resetExpiresIn, revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        if (new URL(url).origin !== origin) throw new NativeAuthError(400, "INVALID_RETURN_URL", "Endereço de recuperação inválido.");
        await deliver(user.email, "reset", resetMail(user.email, url));
      },
    },
    emailVerification: { autoSignInAfterVerification: false, sendOnSignIn: false },
    verification: { storeIdentifier: { hash: (identifier) => verificationIdentifier(config, identifier) } },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    // The public wrapper below applies shared atomic D1 limits and email serialization.
    // No generated Better Auth endpoint is exposed without that wrapper.
    rateLimit: { enabled: false },
    advanced: { cookiePrefix: "cafegestor", useSecureCookies: origin.startsWith("https:"), defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:") }, ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] }, database: { generateId: () => crypto.randomUUID() } },
    account: { accountLinking: { enabled: false } },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    logger: { disabled: true },
    plugins: [emailOTP({
      otpLength: authPolicies.otpDigits, expiresIn: authPolicies.otpExpiresIn, allowedAttempts: authPolicies.otpAllowedAttempts,
      sendVerificationOnSignUp: true, overrideDefaultEmailVerification: true, disableSignUp: true,
      storeOTP: { hash: (otp) => secretDigest(config, `verification-otp:${otp}`) },
      async sendVerificationOTP({ email, otp, type }) {
        if (type !== "email-verification") throw new NativeAuthError(400, "OTP_TYPE_NOT_ALLOWED", "Este tipo de código não está disponível.");
        await deliver(email, "verification", verificationMail(email, otp));
      },
    })],
  });
}

const responseHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
function authError(error: NativeAuthError) { return Response.json({ code: error.code, error: error.message, message: error.message }, { status: error.status, headers: { ...responseHeaders, ...(error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) } }); }
const allowedPost = new Set(["/sign-up/email", "/sign-in/email", "/sign-out", "/email-otp/send-verification-otp", "/email-otp/verify-email", "/request-password-reset", "/reset-password"]);
const emailPaths = new Set(["/sign-up/email", "/email-otp/send-verification-otp", "/request-password-reset"]);
const allowedFields: Record<string, string[]> = {
  "/sign-up/email": ["name", "email", "password", "callbackURL"], "/sign-in/email": ["email", "password", "rememberMe", "callbackURL"],
  "/sign-out": [], "/email-otp/send-verification-otp": ["email", "type"], "/email-otp/verify-email": ["email", "otp"],
  "/request-password-reset": ["email", "redirectTo"], "/reset-password": ["newPassword", "token"],
};
function validateBody(path: string, value: unknown, origin: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeAuthError(400, "INVALID_REQUEST", "Solicitação inválida.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowedFields[path]?.includes(key))) throw new NativeAuthError(400, "INVALID_REQUEST", "A solicitação contém campos não permitidos.");
  if (["/sign-up/email", "/sign-in/email", "/email-otp/send-verification-otp", "/email-otp/verify-email", "/request-password-reset"].includes(path)) {
    if (typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) throw new NativeAuthError(400, "INVALID_EMAIL", "Informe um e-mail válido.");
    body.email = body.email.trim().toLowerCase();
  }
  if (path === "/sign-up/email" && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120)) throw new NativeAuthError(400, "INVALID_NAME", "Informe um nome de até 120 caracteres.");
  if (typeof body.name === "string") body.name = body.name.trim();
  const password = path === "/reset-password" ? body.newPassword : body.password;
  if (["/sign-up/email", "/reset-password"].includes(path) && (typeof password !== "string" || password.length < 10 || password.length > 128)) throw new NativeAuthError(400, "INVALID_PASSWORD", "A senha deve ter entre 10 e 128 caracteres.");
  if (path === "/sign-in/email" && (typeof password !== "string" || password.length < 1 || password.length > 128)) throw new NativeAuthError(400, "INVALID_PASSWORD", "Informe sua senha.");
  if (path === "/email-otp/send-verification-otp" && body.type !== "email-verification") throw new NativeAuthError(400, "OTP_TYPE_NOT_ALLOWED", "Somente a verificação de e-mail por código está disponível.");
  if (path === "/email-otp/verify-email" && (typeof body.otp !== "string" || !/^\d{6}$/.test(body.otp))) throw new NativeAuthError(400, "INVALID_OTP", "Informe o código de 6 dígitos.");
  if (path === "/reset-password" && (typeof body.token !== "string" || body.token.length < 10 || body.token.length > 500)) throw new NativeAuthError(400, "INVALID_TOKEN", "O link de recuperação é inválido ou expirou.");
  for (const key of ["callbackURL", "redirectTo"]) if (body[key] !== undefined) {
    if (typeof body[key] !== "string" || !body[key]) throw new NativeAuthError(400, "INVALID_RETURN_URL", "Endereço de retorno inválido.");
    const url = new URL(body[key] as string, origin);
    if (url.origin !== origin || url.username || url.password || (body[key] as string).includes("\\")) throw new NativeAuthError(400, "INVALID_RETURN_URL", "Endereço de retorno inválido.");
    body[key] = url.toString();
  }
  if (path === "/request-password-reset") body.redirectTo = origin + "/redefinir-senha";
  return body;
}

export async function handleAuthRequest(config: AuthConfig, db: D1Database, request: Request, options: CreateAuthOptions = {}): Promise<Response> {
  let lock: { key: string; token: string } | undefined;
  try {
    const origin = authOrigin(config), url = new URL(request.url), path = url.pathname.slice("/api/auth".length);
    if (!url.pathname.startsWith("/api/auth/") || (request.method === "POST" ? !allowedPost.has(path) : request.method !== "GET" || !(path === "/get-session" || /^\/reset-password\/[A-Za-z0-9_-]+$/.test(path)))) return Response.json({ error: "Rota não encontrada." }, { status: 404, headers: responseHeaders });
    if (url.origin !== origin) throw new NativeAuthError(403, "INVALID_ORIGIN", "Origem da solicitação não autorizada.");
    if ((config.BETTER_AUTH_SECRET?.trim().length || 0) < 32) throw new NativeAuthError(503, "AUTH_NOT_CONFIGURED", "A autenticação segura ainda não foi configurada.");
    let body: Record<string, unknown> = {};
    const headers = new Headers(request.headers);
    for (const name of Array.from(headers.keys())) if (name.startsWith("oai-authenticated-user-") || name === "x-forwarded-for") headers.delete(name);
    if (request.method === "POST") {
      if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") throw new NativeAuthError(403, "INVALID_ORIGIN", "Origem da solicitação não autorizada.");
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new NativeAuthError(415, "INVALID_CONTENT_TYPE", "Envie os dados como application/json.");
      if (Number(request.headers.get("content-length") || 0) > 8192) throw new NativeAuthError(413, "REQUEST_TOO_LARGE", "A solicitação é muito grande.");
      const text = await request.text(); if (text.length > 8192) throw new NativeAuthError(413, "REQUEST_TOO_LARGE", "A solicitação é muito grande.");
      let raw: unknown; try { raw = JSON.parse(text); } catch { throw new NativeAuthError(400, "INVALID_REQUEST", "Solicitação inválida."); }
      body = validateBody(path, raw, origin);
      if (emailPaths.has(path) && !options.mailer && !nativeAuthStatus(config).mailConfigured) throw new NativeAuthError(503, "EMAIL_NOT_CONFIGURED", "O envio de e-mails ainda não foi configurado pelo responsável pela plataforma.");
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      // Bounded maintenance keeps anonymous guard records from growing forever.
      if (crypto.getRandomValues(new Uint8Array(1))[0] < 4) await cleanupExpiredAuthGuards(db);
      await consumeAuthLimit(db, await secretDigest(config, `ip:${path}:${ip}`), path === "/sign-up/email" ? 10 : 60, 900);
      let principal = typeof body.email === "string" ? `email:${body.email}` : typeof body.token === "string" ? `token:${body.token}` : `session:${request.headers.get("cookie") || ip}`;
      if (path === "/reset-password") {
        // Share the login lock, so a concurrent old-password login cannot finish
        // creating a session after password reset has revoked earlier sessions.
        const owner = await db.prepare("SELECT u.email FROM auth_verifications v JOIN auth_users u ON u.id=v.value WHERE v.identifier=? AND v.expires_at>?").bind(await verificationIdentifier(config, `reset-password:${body.token}`), Date.now()).first<{ email: string }>();
        if (owner) principal = `email:${owner.email.toLowerCase()}`;
      }
      await consumeAuthLimit(db, await secretDigest(config, `principal:${path}:${principal}`), path === "/sign-in/email" ? 10 : path === "/sign-up/email" || path === "/request-password-reset" ? 5 : 30, 900);
      const key = await secretDigest(config, `lock:${principal}`); lock = { key, token: await acquireAuthLock(db, key) };
      if (emailPaths.has(path)) {
        // This runs while holding the email lock and BEFORE Better Auth rotates
        // its OTP/token. A refused resend must leave the existing code usable.
        const kind = path === "/request-password-reset" ? "reset" : "verification";
        await assertMailCooldown(db, await secretDigest(config, `mail:${kind}:${body.email}`));
      }
    }
    let deliveryError: NativeAuthError | undefined;
    const auth = createAuth(config, db, { ...options, onDeliveryError: (error) => { deliveryError = error; options.onDeliveryError?.(error); } });
    const passed = new Request(request.url, { method: request.method, headers, ...(request.method === "POST" ? { body: JSON.stringify(body) } : {}) });
    const result = await auth.handler(passed);
    if (deliveryError) return authError(deliveryError);
    const resultHeaders = new Headers(result.headers); for (const [key, value] of Object.entries(responseHeaders)) resultHeaders.set(key, value);
    return new Response(result.body, { status: result.status, headers: resultHeaders });
  } catch (error) {
    if (error instanceof NativeAuthError) return authError(error);
    return authError(new NativeAuthError(500, "AUTH_REQUEST_FAILED", "Não foi possível concluir a autenticação. Tente novamente."));
  } finally { if (lock) try { await releaseAuthLock(db, lock.key, lock.token); } catch { /* Locks expire independently after a Worker failure. */ } }
}
