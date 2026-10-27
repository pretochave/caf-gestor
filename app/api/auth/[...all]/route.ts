import { env } from "cloudflare:workers";
import { handleAuthRequest, type AuthConfig } from "@/lib/auth-core";
import { handleFirebaseAuthRequest, usesFirebase } from "@/lib/firebase-auth";
const unavailable = () => Response.json({ code: "AUTH_NOT_CONFIGURED", error: "O banco de autenticação ainda não foi configurado.", message: "O banco de autenticação ainda não foi configurado." }, { status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
function handle(request: Request) {
  const config = env as AuthConfig;
  return env.DB ? (usesFirebase(config) ? handleFirebaseAuthRequest(config, env.DB, request) : handleAuthRequest(config, env.DB, request)) : unavailable();
}
export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
