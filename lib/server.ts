import { env } from "cloudflare:workers";
import { getAppUser } from "./auth-server";
import { activeSubscription, ApiError } from "./security";
import { verifiedAdministrator } from "./auth-policy";
import { billingLiveMode, billingStatus, type BillingConfig } from "./billing";
import type { AppData, Plan, PlatformSettings, Profile, Subscription } from "./types";

export const defaultPlans: Plan[] = [
  { id: "free", name: "Grátis", price: 0, period: "monthly", farmLimit: 1, plotLimit: 5, trialDays: 0, active: true, visible: true, order: 0, benefits: ["1 fazenda e até 5 talhões", "Controle de custos e produção", "Dashboard essencial"], features: { simulator: false, reports: false, export: false, advanced: false } },
  { id: "pro", name: "Pro", price: 49.9, period: "monthly", farmLimit: 5, plotLimit: 50, trialDays: 0, active: true, visible: true, order: 1, benefits: ["Até 5 fazendas e 50 talhões", "Relatórios e exportação de dados", "Simulador de rentabilidade", "Gráficos avançados"], features: { simulator: true, reports: true, export: true, advanced: true } },
  { id: "premium", name: "Premium", price: 99.9, period: "monthly", farmLimit: 50, plotLimit: 500, trialDays: 0, active: true, visible: true, order: 2, benefits: ["Até 50 fazendas e 500 talhões", "Todos os recursos do Pro", "Suporte prioritário", "Limites ampliados para sua operação"], features: { simulator: true, reports: true, export: true, advanced: true } },
];
export const defaultSettings: PlatformSettings = {
  platformName: "CaféGestor", description: "Cuide da sua fazenda com a mesma dedicação que você cuida do seu café. Custos, safras e resultados, juntos em um só lugar.", supportEmail: "", notice: "",
  privacy: "O CaféGestor utiliza seus dados para fornecer os serviços de gestão rural. Seus registros são vinculados à sua conta e não ficam acessíveis a outros produtores. Você pode solicitar atendimento e excluir seus dados na área de conta. Esta política deve ser complementada pelo responsável antes do lançamento comercial, incluindo identificação do controlador, base legal e prazos de retenção.",
  terms: "O CaféGestor auxilia a organização de dados de produção e finanças. O produtor é responsável pela exatidão dos registros. Recursos pagos dependem de assinatura confirmada. Os termos devem ser revisados e complementados pelo responsável antes do lançamento comercial.",
};
export function config() { return env as Cloudflare.Env & { ADMIN_EMAIL?: string }; }
export function currentBillingMode(): number { return billingLiveMode(env as BillingConfig) ? 1 : 0; }
export function database(): D1Database {
  if (!env.DB) throw new ApiError(503, "O banco de dados ainda não foi configurado. Conecte o D1 e aplique as migrações.");
  return env.DB;
}
export type DbRow = Record<string, unknown>;
export async function rows(db: D1Database, sql: string, ...bindings: (string | number | null)[]): Promise<DbRow[]> {
  const result = await db.prepare(sql).bind(...bindings).all<DbRow>();
  return result.results ?? [];
}
export async function first(db: D1Database, sql: string, ...bindings: (string | number | null)[]): Promise<DbRow | null> {
  return db.prepare(sql).bind(...bindings).first<DbRow>();
}
export function decode(row: DbRow): Record<string, unknown> {
  const value = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return { ...(value as Record<string, unknown>), id: row.id, ...(row.owner_id ? { ownerId: row.owner_id, userId: row.owner_id } : {}), ...(row.farm_id ? { farmId: row.farm_id } : {}), ...(row.plot_id ? { plotId: row.plot_id } : {}), ...(row.season_id ? { seasonId: row.season_id } : {}), ...(row.user_id ? { userId: row.user_id } : {}), createdAt: row.created_at, updatedAt: row.updated_at };
}
export function camel(row: DbRow): DbRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), ["livemode", "cancel_at_period_end", "email_verified"].includes(key) ? Boolean(value) : value]));
}
export function asProfile(row: DbRow, plan = "free"): Profile {
  return { ...camel(row), id: String(row.id), name: String(row.name), email: String(row.email), role: verifiedAdministrator(String(row.email), row.email_verified === true || row.email_verified === 1, config().ADMIN_EMAIL) ? "admin" : "producer", plan, status: row.status as Profile["status"], lastLogin: String(row.last_access) };
}
export async function initialize(db: D1Database): Promise<void> {
  await db.batch([
    ...defaultPlans.map((plan) => db.prepare("INSERT INTO plans (id, payload) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").bind(plan.id, JSON.stringify(plan))),
    db.prepare("INSERT INTO settings (id, payload) VALUES ('public', ?) ON CONFLICT(id) DO NOTHING").bind(JSON.stringify(defaultSettings)),
  ]);
}
export async function publicConfig(db: D1Database): Promise<{ plans: Plan[]; settings: PlatformSettings }> {
  const [planRows, settingRow] = await Promise.all([rows(db, "SELECT * FROM plans"), first(db, "SELECT payload FROM settings WHERE id = 'public'")]);
  const plans = planRows.map((row) => decode(row) as unknown as Plan).sort((a, b) => a.order - b.order);
  const settings = { ...defaultSettings, ...(settingRow ? JSON.parse(String(settingRow.payload)) : {}) };
  return { plans, settings };
}
export async function identity(db: D1Database, required = true): Promise<Profile | null> {
  const auth = await getAppUser();
  if (!auth) { if (required) throw new ApiError(401, "Entre na sua conta para continuar."); return null; }
  const inserted = await db.prepare("INSERT INTO profiles (id, name, email, email_verified) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO NOTHING").bind(auth.userId, auth.fullName || auth.displayName, auth.email).run();
  if (inserted.meta.changes) await db.prepare("INSERT INTO events (id, type, user_id, message) VALUES (?, 'registration', ?, 'Nova conta cadastrada')").bind(crypto.randomUUID(), auth.userId).run();
  await db.prepare("UPDATE profiles SET email = ?, email_verified = 1, last_access = CURRENT_TIMESTAMP WHERE id = ?").bind(auth.email, auth.userId).run();
  const profile = asProfile((await first(db, "SELECT * FROM profiles WHERE id = ?", auth.userId))!);
  if (profile.status === "suspended") throw new ApiError(403, "Sua conta está suspensa. Entre em contato com o suporte.");
  return profile;
}
export async function entitlements(db: D1Database, profile: Profile, availablePlans: Plan[]): Promise<{ plan: Plan; subscription: Subscription | null; billingSubscription: Subscription | null; subscriptions: Subscription[] }> {
  const subscriptions = (await rows(db, "SELECT * FROM subscriptions WHERE user_id = ? AND livemode = ? ORDER BY created_at DESC", profile.id, currentBillingMode())).map((row) => ({ ...camel(row), price: row.amount })) as unknown as Subscription[];
  const subscription = activeSubscription(subscriptions);
  const plan = availablePlans.find((p) => p.id === subscription?.planId) ?? availablePlans.find((p) => p.id === "free") ?? defaultPlans[0];
  return { plan, subscription, billingSubscription: subscriptions.find((s) => !["canceled", "incomplete_expired"].includes(s.status)) ?? null, subscriptions };
}
export function emptyData(settings = defaultSettings, plans = defaultPlans): AppData {
  return { profile: null, farms: [], plots: [], seasons: [], expenses: [], productions: [], revenues: [], plans: plans.filter((p) => p.active && p.visible), tickets: [], settings, integration: { payments: billingStatus(env as BillingConfig).configured ? "configured" : "pending_configuration", adminConfigured: Boolean(config().ADMIN_EMAIL?.trim()) } };
}
export async function requireAdmin(profile: Profile): Promise<void> {
  if (profile.role !== "admin") throw new ApiError(403, "Acesso restrito à administração.");
}
export function auditStatement(db: D1Database, actor: string, action: string, entity: string, targetId: string) {
  return db.prepare("INSERT INTO audit (id, actor_id, action, entity, target_id) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), actor, action, entity, targetId);
}
