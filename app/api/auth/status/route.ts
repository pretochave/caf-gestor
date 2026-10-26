import { env } from "cloudflare:workers";
import { nativeAuthStatus, type AuthConfig } from "@/lib/auth-policy";
export async function GET() { return Response.json(nativeAuthStatus(env as AuthConfig, Boolean(env.DB)), { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
