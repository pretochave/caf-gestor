import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAuth } from "./auth-core";
import { authOrigin, NativeAuthError, safeAuthReturnPath, type AuthConfig } from "./auth-policy";
import { getFirebaseAppUser, usesFirebase } from "./firebase-auth";
export type AppUser = { userId: string; email: string; displayName: string; fullName: string; emailVerified: true };
export function authConfiguration(): AuthConfig { return env as AuthConfig; }
export function serverAuth() {
  if (!env.DB) throw new NativeAuthError(503, "AUTH_NOT_CONFIGURED", "O banco de autenticação ainda não foi configurado.");
  return createAuth(authConfiguration(), env.DB);
}
export async function getAppUser(): Promise<AppUser | null> {
  const requestHeaders = await headers();
  const config = authConfiguration();
  if (usesFirebase(config)) return env.DB ? getFirebaseAppUser(config, env.DB, requestHeaders) : null;
  // Identity headers from the previous hosting service are never an auth source.
  if (!/(?:^|;\s*)(?:__Secure-)?cafegestor\.session_token=/.test(requestHeaders.get("cookie") || "")) return null;
  if (!env.DB || (config.BETTER_AUTH_SECRET?.trim().length || 0) < 32) return null;
  try { authOrigin(config); } catch { return null; }
  const session = await serverAuth().api.getSession({ headers: requestHeaders, query: { disableCookieCache: true } });
  if (!session?.user.emailVerified) return null;
  return { userId: session.user.id, email: session.user.email, displayName: session.user.name || session.user.email, fullName: session.user.name, emailVerified: true };
}
export async function requireAppUser(returnTo: string): Promise<AppUser> {
  const user = await getAppUser();
  if (user) return user;
  redirect("/login?next=" + encodeURIComponent(safeAuthReturnPath(returnTo)));
}
