import { env } from "cloudflare:workers";
import { nativeAuthStatus, type AuthConfig } from "@/lib/auth-policy";
import { firebaseAuthStatus, usesFirebase } from "@/lib/firebase-auth";
export async function GET() {
  const config = env as AuthConfig;
  return Response.json(usesFirebase(config) ? firebaseAuthStatus(config, Boolean(env.DB)) : nativeAuthStatus(config, Boolean(env.DB)), { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
