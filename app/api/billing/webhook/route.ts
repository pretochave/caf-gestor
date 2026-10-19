import { env } from "cloudflare:workers";
import { BillingError, parseStripeEvent, processStripeEvent, verifyStripeSignature, type BillingConfig } from "@/lib/billing";
import { database } from "@/lib/server";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
export async function POST(request: Request) {
  const configuration = env as BillingConfig;
  if (!configuration.STRIPE_SECRET_KEY || !configuration.STRIPE_WEBHOOK_SECRET) return Response.json({ error: "Webhook de cobrança ainda não configurado." }, { status: 503, headers });
  try {
    if (Number(request.headers.get("content-length") || 0) > 1_000_000) throw new BillingError(413, "Evento muito grande.");
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > 1_000_000) throw new BillingError(413, "Evento muito grande.");
    if (!await verifyStripeSignature(raw, request.headers.get("stripe-signature"), configuration.STRIPE_WEBHOOK_SECRET)) throw new BillingError(400, "Assinatura do webhook inválida ou expirada.");
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new BillingError(400, "Evento JSON inválido."); }
    const event = parseStripeEvent(payload);
    const result = await processStripeEvent(database(), configuration, event);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof BillingError) return Response.json({ error: error.message }, { status: error.status, headers });
    return Response.json({ error: "A confirmação de cobrança será repetida pelo provedor." }, { status: 500, headers });
  }
}
