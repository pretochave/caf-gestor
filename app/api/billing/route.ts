import { env } from "cloudflare:workers";
import { z } from "zod/v3";
import { BillingError, billingStatus, createCheckout, createPortal, type BillingConfig } from "@/lib/billing";
import { ApiError, assertSameOrigin } from "@/lib/security";
import { database, identity, initialize, publicConfig } from "@/lib/server";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("checkout"), planId: z.string().min(1).max(200), period: z.enum(["monthly", "annual"]).optional() }).strict(),
  z.object({ action: z.literal("portal") }).strict(),
]);
export async function GET() {
  return Response.json(billingStatus(env as BillingConfig), { headers });
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const text = await request.text();
    if (text.length > 4096) throw new ApiError(413, "A solicitação é muito grande.");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new ApiError(400, "JSON inválido."); }
    const input = inputSchema.parse(body);
    const db = database(); await initialize(db);
    const profile = (await identity(db))!;
    const configuration = env as BillingConfig;
    if (input.action === "portal") return Response.json(await createPortal(db, configuration, profile), { headers });
    const { plans } = await publicConfig(db);
    const plan = plans.find((p) => p.id === input.planId);
    if (!plan) throw new ApiError(404, "Plano não encontrado.");
    return Response.json(await createCheckout(db, configuration, profile, plan, input.period), { headers });
  } catch (error) {
    if (error instanceof ApiError || error instanceof BillingError) return Response.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof z.ZodError) return Response.json({ error: "Solicitação de cobrança inválida." }, { status: 400, headers });
    return Response.json({ error: "Não foi possível concluir a solicitação de cobrança. Tente novamente." }, { status: 500, headers });
  }
}
