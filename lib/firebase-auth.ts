import { acquireAuthLock, assertMailCooldown, authOrigin, cleanupExpiredAuthGuards, consumeAuthLimit, NativeAuthError, releaseAuthLock, reserveAuthMail, secretDigest, type AuthConfig } from "./auth-policy";

type Fetcher = typeof fetch;
export type FirebaseAuthOptions = { fetcher?: Fetcher; now?: () => number };
export type FirebaseAppUser = { userId: string; email: string; displayName: string; fullName: string; emailVerified: true };
type ProviderUser = { localId: string; email: string; displayName?: string; emailVerified?: boolean; disabled?: boolean; validSince?: string; passwordUpdatedAt?: number };
type Credentials = { idToken: string; refreshToken: string; passwordUpdatedAt?: number };
type SessionRow = { token_hash: string; owner_id: string; project_id: string; uid: string; email: string; kind: string; encrypted_tokens: string; created_at: number; expires_at: number };
type CheckedSession = { row: SessionRow; credentials: Credentials; user: ProviderUser };
const responseHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const allowedFields: Record<string, string[]> = {
  "/sign-up/email": ["name", "email", "password"], "/sign-in/email": ["email", "password", "rememberMe"],
  "/send-verification-email": ["email", "password"], "/verify-email": ["oobCode"],
  "/request-password-reset": ["email", "redirectTo"], "/reset-password": ["token", "newPassword"], "/sign-out": [],
};
const currentTime = (options: FirebaseAuthOptions) => Math.floor((options.now?.() ?? Date.now()) / 1000);
export const usesFirebase = (config: AuthConfig) => config.AUTH_PROVIDER !== "resend";
export function firebaseAuthStatus(config: AuthConfig, hasDatabase = true) {
  const missing: string[] = [];
  if (!hasDatabase) missing.push("DB");
  if ((config.BETTER_AUTH_SECRET?.trim().length || 0) < 32) missing.push("BETTER_AUTH_SECRET");
  try { authOrigin(config); } catch { missing.push("SITE_URL"); }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(config.FIREBASE_API_KEY || "")) missing.push("FIREBASE_API_KEY");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.FIREBASE_PROJECT_ID || "")) missing.push("FIREBASE_PROJECT_ID");
  return { provider: "firebase", verificationMethod: "link", configured: missing.length === 0, mailConfigured: !missing.some(key => ["FIREBASE_API_KEY", "FIREBASE_PROJECT_ID"].includes(key)), missing, policies: { resendInterval: 60, sessionExpiresIn: 604800 } };
}
function requireConfiguration(config: AuthConfig) {
  if (!firebaseAuthStatus(config).configured) throw new NativeAuthError(503, "AUTH_NOT_CONFIGURED", "O acesso por e-mail ainda está sendo configurado. Tente novamente em breve.");
}
function cookieName(config: AuthConfig) { return authOrigin(config).startsWith("https:") ? "__Host-cafegestor.firebase_session" : "cafegestor.firebase_session"; }
function cookieToken(config: AuthConfig, headers: Headers) {
  const name = cookieName(config);
  const value = (headers.get("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(name + "="))?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function cookie(config: AuthConfig, value: string, maxAge?: number) {
  return `${cookieName(config)}=${value}; Path=/; HttpOnly; SameSite=Lax${authOrigin(config).startsWith("https:") ? "; Secure" : ""}${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;
}
function base64(value: Uint8Array) { return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function bytes(value: string) { return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)); }
async function encryptionKey(config: AuthConfig) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cafegestor-firebase-tokens:v1:" + config.BETTER_AUTH_SECRET));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(config: AuthConfig, credentials: Credentials, tokenHash: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(tokenHash) }, await encryptionKey(config), new TextEncoder().encode(JSON.stringify(credentials)));
  return base64(iv) + "." + base64(new Uint8Array(encrypted));
}
async function decrypt(config: AuthConfig, value: string, tokenHash: string): Promise<Credentials> {
  const [iv, encrypted] = value.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: new TextEncoder().encode(tokenHash) }, await encryptionKey(config), bytes(encrypted));
  const decoded = JSON.parse(new TextDecoder().decode(plain));
  if (typeof decoded.idToken !== "string" || typeof decoded.refreshToken !== "string") throw new Error("Invalid credential envelope");
  return decoded as Credentials;
}
function providerFailure(code: string): NativeAuthError {
  if (["INVALID_PASSWORD", "EMAIL_NOT_FOUND", "INVALID_LOGIN_CREDENTIALS"].includes(code)) return new NativeAuthError(401, "INVALID_CREDENTIALS", "E-mail ou senha incorretos.");
  if (code === "EMAIL_EXISTS") return new NativeAuthError(409, "EMAIL_ALREADY_EXISTS", "Este e-mail já possui cadastro. Entre na conta ou recupere sua senha.");
  if (["INVALID_ID_TOKEN", "TOKEN_EXPIRED", "INVALID_REFRESH_TOKEN", "USER_NOT_FOUND", "USER_DISABLED", "CREDENTIAL_TOO_OLD_LOGIN_AGAIN"].includes(code)) return new NativeAuthError(401, "SESSION_EXPIRED", "Sua sessão expirou. Entre novamente para continuar.");
  if (["EXPIRED_OOB_CODE", "INVALID_OOB_CODE"].includes(code)) return new NativeAuthError(400, "INVALID_TOKEN", "Este link é inválido, expirou ou já foi utilizado. Solicite um novo e-mail.");
  if (code.startsWith("WEAK_PASSWORD") || code === "PASSWORD_DOES_NOT_MEET_REQUIREMENTS") return new NativeAuthError(400, "INVALID_PASSWORD", "Escolha uma senha mais forte, com pelo menos 10 caracteres.");
  if (code === "TOO_MANY_ATTEMPTS_TRY_LATER") return new NativeAuthError(429, "TOO_MANY_REQUESTS", "Muitas solicitações. Aguarde alguns minutos e tente novamente.", 60);
  return new NativeAuthError(503, "AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação não concluiu a solicitação. Tente novamente em breve.");
}
class ProviderError extends Error {
  readonly providerCode: string;
  constructor(providerCode: string) { super("Firebase request failed"); this.providerCode = providerCode; }
}
async function provider(config: AuthConfig, endpoint: string, body: Record<string, unknown>, options: FirebaseAuthOptions, refresh = false): Promise<Record<string, unknown>> {
  const url = refresh ? "https://securetoken.googleapis.com/v1/token" : "https://identitytoolkit.googleapis.com/v1/accounts:" + endpoint;
  let response: Response;
  try {
    response = await (options.fetcher || fetch)(url + "?key=" + encodeURIComponent(config.FIREBASE_API_KEY!), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000),
      headers: { "Content-Type": refresh ? "application/x-www-form-urlencoded" : "application/json", "X-Firebase-Locale": "pt-BR" },
      body: refresh ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    });
  } catch { throw new NativeAuthError(503, "AUTH_PROVIDER_UNAVAILABLE", "Não foi possível conectar ao serviço de autenticação. Tente novamente em breve."); }
  let result: Record<string, unknown>;
  try { result = await response.json() as Record<string, unknown>; } catch { throw new NativeAuthError(503, "AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação retornou uma resposta incompleta. Tente novamente."); }
  if (!result || typeof result !== "object" || Array.isArray(result) || (response.ok && result.error !== undefined)) throw new NativeAuthError(503, "AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação retornou uma resposta incompleta. Tente novamente.");
  if (!response.ok) {
    const raw = (result.error as { message?: unknown } | undefined)?.message;
    const code = typeof raw === "string" ? raw.split(" : ")[0] : "PROVIDER_ERROR";
    if (response.status >= 500) throw new NativeAuthError(503, "AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação está indisponível. Tente novamente em breve.");
    throw new ProviderError(code);
  }
  return result;
}
function checkedCredentials(result: Record<string, unknown>, refresh = false): Credentials {
  const idToken = refresh ? result.id_token : result.idToken;
  const refreshToken = refresh ? result.refresh_token : result.refreshToken;
  if (typeof idToken !== "string" || !idToken || typeof refreshToken !== "string" || !refreshToken) throw new NativeAuthError(503, "AUTH_PROVIDER_UNAVAILABLE", "O serviço de autenticação não confirmou a sessão. Tente novamente.");
  return { idToken, refreshToken };
}
async function lookup(config: AuthConfig, idToken: string, options: FirebaseAuthOptions): Promise<ProviderUser> {
  // Firebase, not the browser or an unverified decoded JWT, validates the token.
  const result = await provider(config, "lookup", { idToken }, options);
  const user = Array.isArray(result.users) && result.users.length === 1 ? result.users[0] as ProviderUser : undefined;
  if (!user || typeof user.localId !== "string" || !user.localId || user.localId.length > 128 || typeof user.email !== "string" || user.disabled === true) throw new NativeAuthError(401, "SESSION_EXPIRED", "Sua sessão expirou. Entre novamente.");
  let claims: { aud?: string; iss?: string; sub?: string; auth_time?: number; exp?: number };
  try { claims = JSON.parse(new TextDecoder().decode(bytes(idToken.split(".")[1]))); }
  catch { throw new NativeAuthError(401, "SESSION_EXPIRED", "Sua sessão expirou. Entre novamente."); }
  if (claims.aud !== config.FIREBASE_PROJECT_ID || claims.iss !== "https://securetoken.google.com/" + config.FIREBASE_PROJECT_ID || claims.sub !== user.localId || typeof claims.auth_time !== "number" || typeof claims.exp !== "number" || claims.exp <= currentTime(options) || (Number(user.validSince || 0) > claims.auth_time)) throw new NativeAuthError(401, "SESSION_EXPIRED", "Sua sessão expirou. Entre novamente.");
  return user;
}
async function sessionHash(config: AuthConfig, token: string) { return secretDigest(config, "firebase-session:" + token); }
function ownerId(config: AuthConfig, uid: string) { return `firebase:${config.FIREBASE_PROJECT_ID}:${uid}`; }
async function createSession(config: AuthConfig, db: D1Database, user: ProviderUser, credentials: Credentials, kind: "pending" | "authenticated", remember: boolean, headers: Headers, options: FirebaseAuthOptions) {
  const token = base64(crypto.getRandomValues(new Uint8Array(32))), hash = await sessionHash(config, token);
  const now = currentTime(options), lifetime = kind === "pending" ? 900 : remember ? 604800 : 86400;
  const envelope = await encrypt(config, { ...credentials, passwordUpdatedAt: user.passwordUpdatedAt }, hash);
  await db.prepare("INSERT INTO firebase_sessions (token_hash, owner_id, project_id, uid, email, kind, encrypted_tokens, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(hash, ownerId(config, user.localId), config.FIREBASE_PROJECT_ID!, user.localId, user.email.toLowerCase(), kind, envelope, now, now + lifetime).run();
  const previous = cookieToken(config, headers);
  if (previous) await db.prepare("DELETE FROM firebase_sessions WHERE token_hash=?").bind(await sessionHash(config, previous)).run();
  return cookie(config, token, remember || kind === "pending" ? lifetime : undefined);
}
async function readSession(config: AuthConfig, db: D1Database, headers: Headers, options: FirebaseAuthOptions, allowPending = false): Promise<CheckedSession | null> {
  const token = cookieToken(config, headers);
  if (!token) return null;
  const hash = await sessionHash(config, token);
  const row = await db.prepare("SELECT * FROM firebase_sessions WHERE token_hash=? AND project_id=? AND expires_at>?").bind(hash, config.FIREBASE_PROJECT_ID!, currentTime(options)).first<SessionRow>();
  if (!row || (!allowPending && row.kind !== "authenticated")) return null;
  try {
    let credentials = await decrypt(config, row.encrypted_tokens, hash);
    // Refresh on every server authorization. Password resets, disabled users and
    // revoked Firebase refresh tokens must not keep an old application session alive.
    let refreshed: Record<string, unknown>;
    try { refreshed = await provider(config, "", { grant_type: "refresh_token", refresh_token: credentials.refreshToken }, options, true); }
    catch (error) {
      // A concurrent request may already have persisted a rotated refresh token.
      const current = await db.prepare("SELECT encrypted_tokens FROM firebase_sessions WHERE token_hash=?").bind(hash).first<{ encrypted_tokens: string }>();
      if (!(error instanceof ProviderError) || !current || current.encrypted_tokens === row.encrypted_tokens) throw error;
      credentials = await decrypt(config, current.encrypted_tokens, hash);
      refreshed = await provider(config, "", { grant_type: "refresh_token", refresh_token: credentials.refreshToken }, options, true);
    }
    const fresh = checkedCredentials(refreshed, true);
    const user = await lookup(config, fresh.idToken, options);
    if (user.localId !== row.uid || ownerId(config, user.localId) !== row.owner_id || user.email.toLowerCase() !== row.email || (credentials.passwordUpdatedAt !== undefined && user.passwordUpdatedAt !== credentials.passwordUpdatedAt)) throw new NativeAuthError(401, "SESSION_EXPIRED", "Sua sessão expirou. Entre novamente.");
    fresh.passwordUpdatedAt = user.passwordUpdatedAt;
    const encrypted = await encrypt(config, fresh, hash);
    const updated = await db.prepare("UPDATE firebase_sessions SET encrypted_tokens=? WHERE token_hash=? AND expires_at>?").bind(encrypted, hash, currentTime(options)).run();
    if (!updated.meta.changes) return null; // A concurrent logout/reset deleted it.
    return { row, credentials: fresh, user };
  } catch (error) {
    if (error instanceof NativeAuthError && error.status !== 401) throw error;
    if (error instanceof ProviderError && providerFailure(error.providerCode).code !== "SESSION_EXPIRED") throw providerFailure(error.providerCode);
    await db.prepare("DELETE FROM firebase_sessions WHERE token_hash=?").bind(hash).run();
    return null;
  }
}
function appUser(config: AuthConfig, user: ProviderUser): FirebaseAppUser {
  return { userId: ownerId(config, user.localId), email: user.email, displayName: user.displayName || user.email, fullName: user.displayName || user.email, emailVerified: true };
}
export async function getFirebaseAppUser(config: AuthConfig, db: D1Database, headers: Headers, options: FirebaseAuthOptions = {}): Promise<FirebaseAppUser | null> {
  if (!cookieToken(config, headers)) return null;
  requireConfiguration(config);
  const session = await readSession(config, db, headers, options);
  return session?.user.emailVerified === true ? appUser(config, session.user) : null;
}
export async function prepareFirebaseIdentityDeletion(config: AuthConfig, db: D1Database, headers: Headers, expectedOwnerId: string, options: FirebaseAuthOptions = {}): Promise<() => Promise<void>> {
  requireConfiguration(config);
  const session = await readSession(config, db, headers, options);
  if (!session || session.user.emailVerified !== true || session.row.owner_id !== expectedOwnerId) throw new NativeAuthError(401, "SESSION_EXPIRED", "Entre novamente antes de excluir sua conta.");
  // Capture the provider-validated credential while the local session still exists.
  // The caller can then commit its D1 deletion before touching the remote identity.
  const idToken = session.credentials.idToken, deletionConfig = { ...config };
  let completed = false;
  return async () => {
    if (completed) return;
    try { await provider(deletionConfig, "delete", { idToken }, options); }
    catch (error) { if (error instanceof ProviderError) throw providerFailure(error.providerCode); throw error; }
    completed = true;
  };
}
export async function deleteFirebaseIdentity(config: AuthConfig, db: D1Database, headers: Headers, expectedOwnerId: string, options: FirebaseAuthOptions = {}) {
  const deleteIdentity = await prepareFirebaseIdentityDeletion(config, db, headers, expectedOwnerId, options);
  await deleteIdentity();
  await db.prepare("DELETE FROM firebase_sessions WHERE owner_id=?").bind(expectedOwnerId).run();
}
function validateBody(path: string, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new NativeAuthError(400, "INVALID_REQUEST", "Solicitação inválida.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !allowedFields[path].includes(key))) throw new NativeAuthError(400, "INVALID_REQUEST", "A solicitação contém campos não permitidos.");
  if (["/sign-up/email", "/sign-in/email", "/send-verification-email", "/request-password-reset"].includes(path)) {
    if (typeof value.email !== "string" || value.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim())) throw new NativeAuthError(400, "INVALID_EMAIL", "Informe um e-mail válido.");
    value.email = value.email.trim().toLowerCase();
  }
  if (path === "/sign-up/email") {
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 120) throw new NativeAuthError(400, "INVALID_NAME", "Informe um nome de até 120 caracteres.");
    value.name = value.name.trim();
  }
  if (["/sign-up/email", "/sign-in/email", "/reset-password"].includes(path) || value.password !== undefined) {
    const password = path === "/reset-password" ? value.newPassword : value.password;
    const minimum = path === "/sign-up/email" || path === "/reset-password" ? 10 : 1;
    if (typeof password !== "string" || password.length < minimum || password.length > 128) throw new NativeAuthError(400, "INVALID_PASSWORD", minimum === 10 ? "A senha deve ter entre 10 e 128 caracteres." : "Informe sua senha.");
  }
  if (value.rememberMe !== undefined && typeof value.rememberMe !== "boolean") throw new NativeAuthError(400, "INVALID_REQUEST", "Solicitação inválida.");
  const code = path === "/reset-password" ? value.token : value.oobCode;
  if (["/verify-email", "/reset-password"].includes(path) && (typeof code !== "string" || !/^[A-Za-z0-9_-]{10,2048}$/.test(code))) throw new NativeAuthError(400, "INVALID_TOKEN", "Este link é inválido ou expirou. Solicite um novo e-mail.");
  return value;
}
function json(body: unknown, status = 200, setCookie?: string) { return Response.json(body, { status, headers: { ...responseHeaders, ...(setCookie ? { "Set-Cookie": setCookie } : {}) } }); }
function errorResponse(error: NativeAuthError, setCookie?: string) { return Response.json({ code: error.code, error: error.message, message: error.message }, { status: error.status, headers: { ...responseHeaders, ...(error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}), ...(setCookie ? { "Set-Cookie": setCookie } : {}) } }); }
async function verificationEmail(config: AuthConfig, db: D1Database, email: string, idToken: string, options: FirebaseAuthOptions) {
  await reserveAuthMail(db, await secretDigest(config, "firebase-mail:verification:" + email));
  try {
    const result = await provider(config, "sendOobCode", { requestType: "VERIFY_EMAIL", idToken, continueUrl: authOrigin(config) + "/login?verified=1", canHandleCodeInApp: false }, options);
    // Firebase documents HTTP 200 as acceptance; some policies omit the email.
    // This acknowledges dispatch, rather than claiming delivery to the inbox.
    if (result.email !== undefined && (typeof result.email !== "string" || result.email.toLowerCase() !== email)) throw new Error("Invalid email acknowledgement");
  } catch { throw new NativeAuthError(503, "EMAIL_DELIVERY_UNAVAILABLE", "O serviço de e-mail não confirmou o envio. Aguarde um minuto e tente novamente."); }
}
export async function handleFirebaseAuthRequest(config: AuthConfig, db: D1Database, request: Request, options: FirebaseAuthOptions = {}): Promise<Response> {
  let lock: { key: string; token: string } | undefined;
  let pendingCookie: string | undefined;
  try {
    const origin = authOrigin(config), url = new URL(request.url), path = url.pathname.slice("/api/auth".length);
    if (!url.pathname.startsWith("/api/auth/") || (request.method === "GET" ? path !== "/get-session" : request.method !== "POST" || !allowedFields[path])) return json({ error: "Rota não encontrada." }, 404);
    if (url.origin !== origin) throw new NativeAuthError(403, "INVALID_ORIGIN", "Origem da solicitação não autorizada.");
    requireConfiguration(config);
    if (request.method === "GET") {
      const user = await getFirebaseAppUser(config, db, request.headers, options);
      return json(user ? { user: { id: user.userId, name: user.fullName, email: user.email, emailVerified: true } } : null);
    }
    if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") throw new NativeAuthError(403, "INVALID_ORIGIN", "Origem da solicitação não autorizada.");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new NativeAuthError(415, "INVALID_CONTENT_TYPE", "Envie os dados como application/json.");
    if (Number(request.headers.get("content-length") || 0) > 8192) throw new NativeAuthError(413, "REQUEST_TOO_LARGE", "A solicitação é muito grande.");
    const text = await request.text();
    if (text.length > 8192) throw new NativeAuthError(413, "REQUEST_TOO_LARGE", "A solicitação é muito grande.");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new NativeAuthError(400, "INVALID_REQUEST", "Solicitação inválida."); }
    const body = validateBody(path, raw), ip = request.headers.get("cf-connecting-ip") || "unknown";
    await consumeAuthLimit(db, await secretDigest(config, `firebase-ip:${path}:${ip}`), path === "/sign-up/email" ? 10 : 60, 900);
    if (crypto.getRandomValues(new Uint8Array(1))[0] < 4) {
      await cleanupExpiredAuthGuards(db);
      await db.prepare("DELETE FROM firebase_sessions WHERE token_hash IN (SELECT token_hash FROM firebase_sessions WHERE expires_at<? LIMIT 50)").bind(currentTime(options)).run();
    }
    if (path === "/sign-out") {
      const token = cookieToken(config, request.headers);
      if (token) await db.prepare("DELETE FROM firebase_sessions WHERE token_hash=?").bind(await sessionHash(config, token)).run();
      return json({ success: true }, 200, cookie(config, "", 0));
    }
    let principal = typeof body.email === "string" ? body.email : typeof body.token === "string" ? body.token : String(body.oobCode);
    if (path === "/reset-password" || path === "/verify-email") {
      const action = await provider(config, "resetPassword", { oobCode: path === "/reset-password" ? body.token : body.oobCode }, options);
      if (action.requestType !== (path === "/reset-password" ? "PASSWORD_RESET" : "VERIFY_EMAIL") || typeof action.email !== "string") throw new NativeAuthError(400, "INVALID_TOKEN", "Este link é inválido ou expirou.");
      principal = action.email.toLowerCase();
    }
    await consumeAuthLimit(db, await secretDigest(config, `firebase-principal:${path}:${principal}`), path === "/sign-in/email" ? 10 : ["/sign-up/email", "/request-password-reset", "/send-verification-email"].includes(path) ? 5 : 20, 900);
    const key = await secretDigest(config, "firebase-lock:" + principal); lock = { key, token: await acquireAuthLock(db, key) };
    if (["/sign-up/email", "/send-verification-email", "/request-password-reset"].includes(path)) await assertMailCooldown(db, await secretDigest(config, `firebase-mail:${path === "/request-password-reset" ? "reset" : "verification"}:${principal}`));
    if (path === "/sign-up/email" || path === "/sign-in/email") {
      let credentials = checkedCredentials(await provider(config, path === "/sign-up/email" ? "signUp" : "signInWithPassword", { email: body.email, password: body.password, returnSecureToken: true }, options));
      if (path === "/sign-up/email") {
        const updated = await provider(config, "update", { idToken: credentials.idToken, displayName: body.name, returnSecureToken: true }, options);
        if (updated.idToken && updated.refreshToken) credentials = checkedCredentials(updated);
      }
      const user = await lookup(config, credentials.idToken, options);
      if (user.email.toLowerCase() !== body.email) throw new NativeAuthError(401, "INVALID_CREDENTIALS", "E-mail ou senha incorretos.");
      if (path === "/sign-up/email") {
        await verificationEmail(config, db, String(body.email), credentials.idToken, options);
        pendingCookie = await createSession(config, db, user, credentials, "pending", false, request.headers, options);
        return json({ success: true, verificationRequired: true, email: user.email }, 200, pendingCookie);
      }
      if (user.emailVerified !== true) {
        pendingCookie = await createSession(config, db, user, credentials, "pending", false, request.headers, options);
        return errorResponse(new NativeAuthError(403, "EMAIL_NOT_VERIFIED", "Confirme seu e-mail antes de entrar. Abra o link recebido ou solicite um novo envio."), pendingCookie);
      }
      const sessionCookie = await createSession(config, db, user, credentials, "authenticated", body.rememberMe !== false, request.headers, options);
      return json({ success: true, user: { id: ownerId(config, user.localId), name: user.displayName || user.email, email: user.email, emailVerified: true } }, 200, sessionCookie);
    }
    if (path === "/send-verification-email") {
      let session = await readSession(config, db, request.headers, options, true);
      let credentials: Credentials, user: ProviderUser;
      if (session && session.user.email.toLowerCase() === body.email) { credentials = session.credentials; user = session.user; }
      else {
        if (typeof body.password !== "string") throw new NativeAuthError(401, "REAUTHENTICATION_REQUIRED", "Informe sua senha para solicitar um novo link de confirmação.");
        credentials = checkedCredentials(await provider(config, "signInWithPassword", { email: body.email, password: body.password, returnSecureToken: true }, options));
        user = await lookup(config, credentials.idToken, options);
      }
      if (user.email.toLowerCase() !== body.email) throw new NativeAuthError(401, "INVALID_CREDENTIALS", "E-mail ou senha incorretos.");
      if (user.emailVerified === true) throw new NativeAuthError(409, "EMAIL_IS_ALREADY_VERIFIED", "Seu e-mail já foi confirmado. Entre com sua senha.");
      await verificationEmail(config, db, String(body.email), credentials.idToken, options);
      if (!session || session.row.kind !== "pending") pendingCookie = await createSession(config, db, user, credentials, "pending", false, request.headers, options);
      return json({ success: true, email: user.email }, 200, pendingCookie);
    }
    if (path === "/verify-email") {
      const result = await provider(config, "update", { oobCode: body.oobCode }, options);
      // The REST documentation's successful sample omits emailVerified. The
      // preceding purpose check plus successful update applies VERIFY_EMAIL;
      // private access still requires a fresh lookup with emailVerified=true.
      if (typeof result.email !== "string" || result.email.toLowerCase() !== principal || result.emailVerified === false) throw new NativeAuthError(503, "AUTH_PROVIDER_UNAVAILABLE", "O serviço não confirmou a verificação. Tente novamente.");
      return json({ success: true, emailVerified: true });
    }
    if (path === "/request-password-reset") {
      await reserveAuthMail(db, await secretDigest(config, "firebase-mail:reset:" + principal));
      try {
        const result = await provider(config, "sendOobCode", { requestType: "PASSWORD_RESET", email: body.email, continueUrl: origin + "/login", canHandleCodeInApp: false }, options);
        // Enumeration protection deliberately omits recipient information for
        // some successful requests. The UI always uses conditional wording.
        if (result.email !== undefined && (typeof result.email !== "string" || result.email.toLowerCase() !== principal)) throw new Error("Invalid email acknowledgement");
      } catch (error) {
        if (!(error instanceof ProviderError && error.providerCode === "EMAIL_NOT_FOUND")) throw new NativeAuthError(503, "EMAIL_DELIVERY_UNAVAILABLE", "O serviço de e-mail não confirmou o envio. Aguarde um minuto e tente novamente.");
      }
      return json({ success: true });
    }
    if (path === "/reset-password") {
      const result = await provider(config, "resetPassword", { oobCode: body.token, newPassword: body.newPassword }, options);
      if (result.requestType !== "PASSWORD_RESET" || typeof result.email !== "string" || result.email.toLowerCase() !== principal) throw new NativeAuthError(503, "AUTH_PROVIDER_UNAVAILABLE", "O serviço não confirmou a alteração da senha. Tente novamente.");
      await db.prepare("DELETE FROM firebase_sessions WHERE project_id=? AND email=?").bind(config.FIREBASE_PROJECT_ID!, principal).run();
      return json({ success: true }, 200, cookie(config, "", 0));
    }
    return json({ error: "Rota não encontrada." }, 404);
  } catch (error) {
    const safe = error instanceof ProviderError ? providerFailure(error.providerCode) : error instanceof NativeAuthError ? error : new NativeAuthError(500, "AUTH_REQUEST_FAILED", "Não foi possível concluir a autenticação. Tente novamente.");
    return errorResponse(safe, pendingCookie);
  } finally { if (lock) try { await releaseAuthLock(db, lock.key, lock.token); } catch { /* Leases expire independently after a Worker failure. */ } }
}
