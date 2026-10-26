import { z } from "zod/v3";
import { ApiError, assertOwner, assertSameOrigin, entitySchemas, mutationSchema, requireFeature } from "@/lib/security";
import { asProfile, auditStatement, camel, currentBillingMode, database, decode, emptyData, entitlements, first, identity, initialize, publicConfig, requireAdmin, rows } from "@/lib/server";
import type { AppData, Plan, Profile, Subscription, Ticket } from "@/lib/types";
import { verificationIdentifier } from "@/lib/auth-policy";
import { authConfiguration } from "@/lib/auth-server";

const tenantTables = { farm: "farms", plot: "plots", season: "seasons", expense: "expenses", production: "productions", revenue: "revenues", ticket: "tickets" } as const;
type TenantEntity = keyof typeof tenantTables;
const adminEntities = new Set(["plan", "crm", "user", "settings"]);
const jsonHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
function json(body: unknown, status = 200) { return Response.json(body, { status, headers: jsonHeaders }); }
async function fail(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) return json({ error: error.issues.map((i) => `${i.path.join(".") ? i.path.join(".") + ": " : ""}${i.message}`).join("; ") }, 400);
  const message = error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}` : "";
  if (/no such table|binding.*unavailable/i.test(message)) return json({ error: "O banco de dados precisa ser conectado e suas migrações aplicadas." }, 503);
  if (/FOREIGN KEY constraint failed/i.test(message)) return json({ error: "Este registro possui vínculos. Remova ou altere os lançamentos relacionados antes de excluir." }, 409);
  if (/UNIQUE constraint failed/i.test(message)) return json({ error: "Já existe um registro com esta identificação." }, 409);
  try {
    await database().prepare("INSERT INTO events (id, type, message) VALUES (?, 'application_error', 'Falha inesperada no processamento da API de dados')").bind(crypto.randomUUID()).run();
  } catch { /* An unavailable database must not obscure the original request failure. */ }
  return json({ error: "Não foi possível concluir a operação. Tente novamente." }, 500);
}

export async function GET(request: Request) {
  try {
    const db = database();
    await initialize(db);
    const { plans, settings } = await publicConfig(db);
    const profile = await identity(db, false);
    const url = new URL(request.url);
    if (!profile) {
      if (url.searchParams.has("export") || url.searchParams.has("feature") || url.searchParams.has("business")) throw new ApiError(401, "Entre na sua conta para continuar.");
      return json(emptyData(settings, plans));
    }
    if (url.searchParams.has("business")) await requireAdmin(profile);
    const { plan, subscription, billingSubscription } = await entitlements(db, profile, plans);
    const billingMode = currentBillingMode();
    profile.plan = plan.id;
    const feature = url.searchParams.get("feature");
    if (feature) {
      if (!["simulator", "reports", "export", "advanced"].includes(feature)) throw new ApiError(400, "Recurso inválido.");
      requireFeature(plan, feature as keyof Plan["features"]);
      return json({ allowed: true });
    }
    if (url.searchParams.has("export")) requireFeature(plan, "export");
    const entries = Object.entries(tenantTables);
    const ownRows = await Promise.all(entries.map(async ([, table]) => [table, (await rows(db, `SELECT * FROM ${table} WHERE owner_id = ? ORDER BY created_at DESC`, profile.id)).map(decode)] as const));
    const data = { ...emptyData(settings, plans), ...Object.fromEntries(ownRows), profile, subscription, billingSubscription, plans: profile.role === "admin" ? plans : plans.filter((p) => (p.visible && p.active) || p.id === plan.id), payments: (await rows(db, "SELECT id, user_id, subscription_id, amount, refunded_amount, status, paid_at, created_at, livemode FROM payments WHERE user_id = ? AND livemode = ? ORDER BY created_at DESC", profile.id, billingMode)).map(camel) } as AppData;
    const exportType = url.searchParams.get("export");
    if (exportType) {
      if (!["json", "csv"].includes(exportType)) throw new ApiError(400, "Formato de exportação inválido.");
      // Exports always contain only the signed-in producer's records, including for an administrator.
      const ownExport = { exportedAt: new Date().toISOString(), profile, farms: data.farms, plots: data.plots, seasons: data.seasons, expenses: data.expenses, productions: data.productions, revenues: data.revenues };
      if (exportType === "json") return new Response(JSON.stringify(ownExport, null, 2), { headers: { ...jsonHeaders, "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="cafegestor-dados.json"' } });
      const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""').replace(/^[=+\-@\t\r]/, "'$&")}"`;
      const lines = [["Tipo", "Fazenda", "Descrição", "Data", "Valor", "Sacas", "Área"]];
      const farmNames = Object.fromEntries(data.farms.map((f) => [f.id, f.name]));
      for (const e of data.expenses) lines.push(["Despesa", farmNames[e.farmId] || "", e.description, e.date, String(e.amount), "", ""]);
      for (const r of data.revenues) lines.push(["Receita", farmNames[r.farmId] || "", r.description, r.date, String(r.amount), "", ""]);
      for (const p of data.productions) lines.push(["Produção", farmNames[p.farmId] || "", "", p.date, "", String(p.bags), String(p.area)]);
      return new Response("\uFEFF" + lines.map((line) => line.map(escape).join(";")).join("\r\n"), { headers: { ...jsonHeaders, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="cafegestor-relatorio.csv"' } });
    }
    if (profile.role === "admin") {
      const [userRows, subscriptionRows, paymentRows, crmRows, auditRows, eventRows, ticketRows, contactRows] = await Promise.all([
        rows(db, "SELECT * FROM profiles ORDER BY created_at DESC"),
        rows(db, "SELECT id, user_id, plan_id, status, amount, period, current_period_end, verified_at, cancel_at_period_end, created_at, updated_at, livemode FROM subscriptions WHERE livemode = ? ORDER BY created_at DESC", billingMode),
        rows(db, "SELECT id, user_id, subscription_id, amount, refunded_amount, status, paid_at, created_at, livemode FROM payments WHERE livemode = ? ORDER BY created_at DESC", billingMode),
        rows(db, "SELECT * FROM crm ORDER BY updated_at DESC"), rows(db, "SELECT * FROM audit ORDER BY created_at DESC LIMIT 300"),
        rows(db, "SELECT * FROM events ORDER BY created_at DESC LIMIT 300"), rows(db, "SELECT * FROM tickets ORDER BY created_at DESC"),
        rows(db, "SELECT * FROM contacts ORDER BY created_at DESC LIMIT 500"),
      ]);
      const subscriptions = subscriptionRows.map((r) => ({ ...camel(r), price: r.amount })) as unknown as Subscription[];
      const users = userRows.map((r) => {
        const active = subscriptions.find((s) => s.userId === r.id && s.verifiedAt && ["active", "trialing"].includes(s.status) && Date.parse(s.currentPeriodEnd) > Date.now());
        return asProfile(r, active?.planId || "free");
      });
      data.business = { users, subscriptions, payments: paymentRows.map(camel), crm: crmRows.map(decode), audit: auditRows.map(camel), events: eventRows.map(camel), tickets: ticketRows.map(decode), contacts: contactRows.map(decode) } as AppData["business"];
    }
    return json(data);
  } catch (error) { return fail(error); }
}

async function owned(db: D1Database, table: string, id: string, profile: Profile) {
  const row = await first(db, `SELECT * FROM ${table} WHERE id = ? AND owner_id = ?`, id, profile.id);
  assertOwner(row?.owner_id as string | undefined, profile.id);
  return row!;
}
async function validateLinks(db: D1Database, profile: Profile, data: Record<string, unknown>) {
  if (data.farmId) await owned(db, "farms", String(data.farmId), profile);
  if (data.plotId) {
    const plot = await owned(db, "plots", String(data.plotId), profile);
    if (plot.farm_id !== data.farmId) throw new ApiError(400, "O talhão não pertence à fazenda selecionada.");
  }
  if (data.seasonId) await owned(db, "seasons", String(data.seasonId), profile);
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (Number(request.headers.get("content-length") || 0) > 100_000) throw new ApiError(413, "O conteúdo enviado é muito grande.");
    const raw = await request.text();
    if (raw.length > 100_000) throw new ApiError(413, "O conteúdo enviado é muito grande.");
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new ApiError(400, "O JSON enviado é inválido."); }
    const { entity, action, id: inputId, data: rawData } = mutationSchema.parse(input);
    const db = database();
    await initialize(db);
    const profile = (await identity(db))!;
    if (adminEntities.has(entity)) await requireAdmin(profile);
    if (action !== "create" && entity !== "settings" && entity !== "profile" && !inputId) throw new ApiError(400, "Informe o registro que deseja alterar.");
    const id = inputId || crypto.randomUUID();
    if (entity === "profile" && action === "delete") {
      if ((rawData as { confirm?: string } | undefined)?.confirm !== "EXCLUIR") throw new ApiError(400, "Confirme a exclusão com EXCLUIR.");
      if (await first(db, "SELECT id FROM subscriptions WHERE user_id = ? AND livemode = 1 AND status NOT IN ('canceled', 'incomplete_expired') LIMIT 1", profile.id)) throw new ApiError(409, "Cancele sua assinatura no portal de cobrança e aguarde a confirmação antes de excluir os dados da conta.");
      if (await first(db, "SELECT id FROM billing_checkouts WHERE user_id = ? AND livemode = 1 AND status IN ('creating','open') AND expires_at > unixepoch() LIMIT 1", profile.id)) throw new ApiError(409, "Existe uma contratação em aberto. Aguarde sua expiração antes de excluir a conta.");
      // Explicit ordering preserves relational integrity and removes personal agricultural data.
      await db.batch([
        ...["expenses", "productions", "revenues", "plots", "farms", "seasons", "tickets"].map((table) => db.prepare(`DELETE FROM ${table} WHERE owner_id = ?`).bind(profile.id)),
        ...["contacts", "crm", "payments", "subscriptions", "events"].map((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(profile.id)),
        db.prepare("DELETE FROM profiles WHERE id = ?").bind(profile.id),
        // Native identity deletion cascades account credentials and every active session.
        db.prepare("DELETE FROM auth_verifications WHERE value = ? OR identifier = ?").bind(profile.id, await verificationIdentifier(authConfiguration(), `email-verification-otp-${profile.email}`)),
        db.prepare("DELETE FROM auth_users WHERE id = ?").bind(profile.id),
        auditStatement(db, "account-deletion", "delete", "profile", "anonymized"),
      ]);
      return json({ ok: true, deleted: true });
    }
    if (entity in tenantTables) {
      const tenantEntity = entity as TenantEntity;
      const table = tenantTables[tenantEntity];
      if (action !== "create") await owned(db, table, id, profile);
      if (action === "delete") {
        if (entity === "farm") {
          await db.batch([
            ...["expenses", "productions", "revenues", "plots"].map((child) => db.prepare(`DELETE FROM ${child} WHERE farm_id = ? AND owner_id = ?`).bind(id, profile.id)),
            db.prepare("DELETE FROM farms WHERE id = ? AND owner_id = ?").bind(id, profile.id),
          ]);
        } else await db.prepare(`DELETE FROM ${table} WHERE id = ? AND owner_id = ?`).bind(id, profile.id).run();
        return json({ ok: true, id });
      }
      const value = entitySchemas[tenantEntity].parse(rawData) as Record<string, unknown>;
      await validateLinks(db, profile, value);
      if (entity === "ticket" && action === "create") {
        value.status = "aberto";
        value.replies = [];
      }
      const columns = ["payload"];
      const values: (string | number | null)[] = [JSON.stringify(value)];
      if (["plot", "expense", "production", "revenue"].includes(entity)) { columns.push("farm_id"); values.push(String(value.farmId)); }
      if (["expense", "production", "revenue"].includes(entity)) { columns.push("plot_id", "season_id"); values.push(value.plotId ? String(value.plotId) : null, value.seasonId ? String(value.seasonId) : null); }
      if (action === "update") {
        await db.prepare(`UPDATE ${table} SET ${columns.map((c) => c === "payload" && entity === "ticket" ? "payload = json_patch(payload, ?)" : `${c} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?`).bind(...values, id, profile.id).run();
      } else {
        const { plans } = await publicConfig(db);
        const { plan } = await entitlements(db, profile, plans);
        const limit = entity === "farm" ? plan.farmLimit : entity === "plot" ? plan.plotLimit : entity === "ticket" ? 200 : null;
        const sql = `INSERT INTO ${table} (id, owner_id, ${columns.join(", ")}) SELECT ?, ?, ${columns.map(() => "?").join(", ")}${limit !== null ? ` WHERE (SELECT COUNT(*) FROM ${table} WHERE owner_id = ?) < ?` : ""}`;
        const bindings = [id, profile.id, ...values, ...(limit !== null ? [profile.id, limit] : [])];
        const result = await db.prepare(sql).bind(...bindings).run();
        if (!result.meta.changes) throw new ApiError(403, entity === "ticket" ? "Limite de chamados alcançado. Entre em contato com o suporte." : "O limite do seu plano foi alcançado. Consulte os planos disponíveis.");
      }
      return json({ ok: true, id }, action === "create" ? 201 : 200);
    }
    if (entity === "profile") {
      if (action !== "update") throw new ApiError(400, "Operação inválida para o perfil.");
      const value = entitySchemas.profile.parse(rawData);
      await db.prepare("UPDATE profiles SET name = ?, phone = ?, city = ?, state = ?, company = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(value.name, value.phone, value.city, value.state, value.company, profile.id).run();
      return json({ ok: true, id: profile.id });
    }
    if (entity === "ticketReply") {
      if (action === "delete") throw new ApiError(400, "Respostas de suporte não podem ser excluídas.");
      const ticketRow = profile.role === "admin" ? await first(db, "SELECT * FROM tickets WHERE id = ?", id) : await owned(db, "tickets", id, profile);
      if (!ticketRow) throw new ApiError(404, "Chamado não encontrado.");
      const value = entitySchemas.ticketReply.parse(rawData);
      if (profile.role !== "admin" && (value.status || value.priority)) throw new ApiError(403, "Somente o suporte pode classificar chamados.");
      if (!value.message?.trim() && !value.status && !value.priority) throw new ApiError(400, "Informe uma resposta ou alteração.");
      const ticket = decode(ticketRow) as unknown as Ticket;
      const replies = [...ticket.replies];
      if (value.message?.trim()) replies.push({ id: crypto.randomUUID(), message: value.message.trim(), author: profile.name, role: profile.role, date: new Date().toISOString() });
      // One JSON append happens in SQL so concurrent support replies cannot overwrite each other.
      const payloadPatch = { ...(value.status ? { status: value.status } : {}), ...(value.priority ? { priority: value.priority } : {}) };
      const ticketPredicate = profile.role === "admin" ? "id = ?" : "id = ? AND owner_id = ?";
      const ticketBindings = profile.role === "admin" ? [id] : [id, profile.id];
      const update = value.message?.trim()
        ? db.prepare(`UPDATE tickets SET payload = json_insert(json_patch(payload, ?), '$.replies[#]', json(?)), updated_at = CURRENT_TIMESTAMP WHERE ${ticketPredicate}`).bind(JSON.stringify(payloadPatch), JSON.stringify(replies.at(-1)), ...ticketBindings)
        : db.prepare(`UPDATE tickets SET payload = json_patch(payload, ?), updated_at = CURRENT_TIMESTAMP WHERE ${ticketPredicate}`).bind(JSON.stringify(payloadPatch), ...ticketBindings);
      await db.batch(profile.role === "admin" ? [update, auditStatement(db, profile.id, "reply", "ticket", id)] : [update]);
      return json({ ok: true, id });
    }
    if (entity === "user") {
      if (action !== "update") throw new ApiError(400, "Somente o status da conta pode ser alterado nesta operação.");
      const value = entitySchemas.user.parse(rawData);
      if (id === profile.id && value.status === "suspended") throw new ApiError(400, "Você não pode suspender a própria conta.");
      if (!await first(db, "SELECT id FROM profiles WHERE id = ?", id)) throw new ApiError(404, "Usuário não encontrado.");
      await db.batch([db.prepare("UPDATE profiles SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(value.status, id), auditStatement(db, profile.id, value.status, "user", id)]);
      return json({ ok: true, id });
    }
    if (entity === "settings") {
      if (action === "delete") throw new ApiError(400, "As configurações públicas não podem ser excluídas.");
      const value = entitySchemas.settings.parse(rawData);
      await db.batch([db.prepare("UPDATE settings SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 'public'").bind(JSON.stringify(value)), auditStatement(db, profile.id, "update", "settings", "public")]);
      return json({ ok: true, id: "public" });
    }
    if (entity === "plan") {
      if (action === "delete") {
        if (["free", "pro", "premium"].includes(id)) throw new ApiError(400, "Desative o plano inicial em vez de excluí-lo.");
        await db.batch([db.prepare("DELETE FROM plans WHERE id = ?").bind(id), auditStatement(db, profile.id, action, entity, id)]);
      } else {
        const value = entitySchemas.plan.parse(rawData);
        if (id === "free" && value.price !== 0) throw new ApiError(400, "O plano padrão gratuito deve permanecer sem cobrança.");
        if (action === "update" && !await first(db, "SELECT id FROM plans WHERE id = ?", id)) throw new ApiError(404, "Plano não encontrado.");
        const statement = action === "create" ? db.prepare("INSERT INTO plans (id, payload) VALUES (?, ?)").bind(id, JSON.stringify(value)) : db.prepare("UPDATE plans SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(JSON.stringify(value), id);
        await db.batch([statement, auditStatement(db, profile.id, action, entity, id)]);
      }
      return json({ ok: true, id });
    }
    if (entity === "crm") {
      if (action === "delete") {
        await db.batch([db.prepare("DELETE FROM crm WHERE id = ?").bind(id), auditStatement(db, profile.id, action, entity, id)]);
      } else {
        const value = entitySchemas.crm.parse(rawData);
        if (!await first(db, "SELECT id FROM profiles WHERE id = ?", value.userId)) throw new ApiError(404, "Usuário não encontrado.");
        await db.batch([
          db.prepare("INSERT INTO crm (id, user_id, payload) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP").bind(id, value.userId, JSON.stringify(value)),
          db.prepare("INSERT INTO contacts (id, user_id, actor_id, payload) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), value.userId, profile.id, JSON.stringify({ stage: value.stage, notes: value.notes, task: value.task })),
          auditStatement(db, profile.id, action, entity, value.userId),
        ]);
      }
      return json({ ok: true, id });
    }
    throw new ApiError(400, "Operação não permitida.");
  } catch (error) { return fail(error); }
}
