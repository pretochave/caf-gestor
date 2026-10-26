import { z } from "zod/v3";
import type { Plan, Subscription } from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function isAdmin(email: string, configuredEmail?: string): boolean {
  return Boolean(configuredEmail?.trim()) && email.trim().toLowerCase() === configuredEmail!.trim().toLowerCase();
}
export function assertOwner(ownerId: string | undefined, userId: string): void {
  if (!ownerId || ownerId !== userId) throw new ApiError(404, "Registro não encontrado.");
}
export function activeSubscription(subscriptions: Subscription[], now = Date.now()): Subscription | null {
  return subscriptions.find((s) => Boolean(s.verifiedAt) && ["active", "trialing"].includes(s.status) && Date.parse(s.currentPeriodEnd) > now) ?? null;
}
export function requireFeature(plan: Plan, feature: keyof Plan["features"]): void {
  if (!plan.features[feature]) throw new ApiError(403, "Este recurso não está incluído no seu plano atual.");
}
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== new URL(request.url).origin)) {
    throw new ApiError(403, "Origem da solicitação não autorizada.");
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "Envie o conteúdo como application/json.");
}

const text = (max = 200) => z.string().trim().max(max);
const name = text().min(1, "Informe um nome.");
const num = z.number().finite().min(0).max(1_000_000_000);
const year = z.number().int().min(1900).max(2200);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.").refine((s) => { const d = new Date(s + "T12:00:00Z"); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, "Data inválida.");
const id = z.string().min(1).max(200);
const optionalId = z.union([id, z.literal("")]).optional().transform((s) => s || undefined);
export const entitySchemas = {
  farm: z.object({ name, city: text().default(""), state: text(2).default(""), totalArea: num, cultivatedArea: num, plants: num.int(), variety: text().default(""), spacing: text(100).default(""), year }).strict().refine((v) => v.cultivatedArea <= v.totalArea, "A área cultivada deve ser menor ou igual à área total."),
  plot: z.object({ farmId: id, name, area: num, plants: num.int(), variety: text().default(""), year }).strict(),
  season: z.object({ name, year, status: z.enum(["planejada", "em andamento", "concluída", "ativa", "encerrada", "Em planejamento", "Em andamento", "Concluída", "planned", "active", "completed"]).default("ativa") }).strict(),
  expense: z.object({ farmId: id, plotId: optionalId, seasonId: optionalId, category: z.enum(["Adubação", "Defensivos", "Mão de obra", "Combustível", "Máquinas", "Irrigação", "Colheita", "Transporte", "Manutenção", "Outras despesas"]), description: text(1000).min(1), amount: num, date, status: z.enum(["pago", "pendente", "paid", "pending", "Pago", "Pendente"]).default("pago") }).strict(),
  production: z.object({ farmId: id, plotId: optionalId, seasonId: optionalId, bags: num, area: num.positive("Informe uma área colhida maior que zero."), date }).strict(),
  revenue: z.object({ farmId: id, seasonId: optionalId, description: text(1000).min(1), amount: num, date }).strict(),
  ticket: z.object({ subject: text(250).min(1), message: text(10000).min(1), priority: z.enum(["baixa", "normal", "alta", "urgente", "Baixa", "Normal", "Alta", "Urgente", "low", "medium", "high", "urgent"]).default("normal") }).strict(),
  profile: z.object({ name, phone: text(30).default(""), city: text().default(""), state: text(2).default(""), company: text().default("") }).strict(),
  plan: z.object({ name, price: num, period: z.enum(["monthly", "annual", "yearly"]).transform((value) => value === "yearly" ? "annual" as const : value), farmLimit: num.int(), plotLimit: num.int(), trialDays: z.number().int().min(0).max(365), active: z.boolean(), visible: z.boolean(), order: z.number().int().min(0).max(1000), benefits: z.array(text(300).min(1)).max(30), features: z.object({ simulator: z.boolean(), reports: z.boolean(), export: z.boolean(), advanced: z.boolean() }).strict() }).strict(),
  crm: z.object({ userId: id, stage: z.enum(["Lead", "Contatado", "Interessado", "Demonstração", "Teste gratuito", "Cliente pagante", "Cancelado", "lead", "contacted", "interested", "demo", "trial", "customer", "canceled"]), notes: text(15000).default(""), task: text(3000).default("") }).strict(),
  user: z.object({ status: z.enum(["active", "suspended"]) }).strict(),
  settings: z.object({ platformName: name, description: text(3000), supportEmail: z.union([z.string().trim().email(), z.literal("")]), notice: text(3000), privacy: text(30000), terms: text(30000), logo: text(2000).optional(), instagram: text(2000).optional(), facebook: text(2000).optional(), website: text(2000).optional() }).strict(),
  ticketReply: z.object({ message: text(10000).optional(), status: z.enum(["aberto", "em atendimento", "respondido", "resolvido", "fechado", "Aberto", "Em atendimento", "Respondido", "Resolvido", "Fechado", "open", "in_progress", "resolved", "closed"]).optional(), priority: z.enum(["baixa", "normal", "alta", "urgente", "Baixa", "Normal", "Alta", "Urgente", "low", "medium", "high", "urgent"]).optional() }).strict(),
};
export const mutationSchema = z.object({ entity: z.enum(["farm", "plot", "season", "expense", "production", "revenue", "ticket", "profile", "plan", "crm", "user", "settings", "ticketReply"]), action: z.enum(["create", "update", "delete"]), id: id.optional(), data: z.unknown().optional() }).strict();
