import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const dir = new URL("../drizzle/", import.meta.url);
  const migrations = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.length, "Generate the real Drizzle migration before running database tests");
  for (const name of migrations) db.exec(readFileSync(new URL(name, dir), "utf8"));
  db.exec("INSERT INTO profiles (id,name,email) VALUES ('a','Ana','ana@example.com'), ('b','Beto','beto@example.com');");
  db.exec("INSERT INTO farms (id,owner_id,payload) VALUES ('fa','a','{}'),('fb','b','{}'),('fa2','a','{}');");
  return db;
}
test("database composite foreign keys reject cross-tenant farm and season links", () => {
  const db = database();
  assert.throws(() => db.exec("INSERT INTO plots (id,owner_id,farm_id,payload) VALUES ('x','b','fa','{}')"), /FOREIGN KEY/);
  db.exec("INSERT INTO seasons (id,owner_id,payload) VALUES ('sa','a','{}');");
  assert.throws(() => db.exec("INSERT INTO expenses (id,owner_id,farm_id,season_id,payload) VALUES ('e','b','fb','sa','{}')"), /FOREIGN KEY/);
  db.close();
});
test("database refuses a plot from another farm even within the same tenant", () => {
  const db = database();
  db.exec("INSERT INTO plots (id,owner_id,farm_id,payload) VALUES ('pa','a','fa','{}')");
  assert.throws(() => db.exec("INSERT INTO productions (id,owner_id,farm_id,plot_id,payload) VALUES ('p','a','fa2','pa','{}')"), /FOREIGN KEY/);
  assert.doesNotThrow(() => db.exec("INSERT INTO productions (id,owner_id,farm_id,plot_id,payload) VALUES ('p','a','fa','pa','{}')"));
  db.close();
});
test("tenant update and delete predicates cannot modify another producer's record", () => {
  const db = database();
  const update = db.prepare("UPDATE farms SET payload = ? WHERE id = ? AND owner_id = ?").run('{"name":"attack"}', "fa", "b");
  const deletion = db.prepare("DELETE FROM farms WHERE id = ? AND owner_id = ?").run("fa", "b");
  assert.equal(Number(update.changes), 0);
  assert.equal(Number(deletion.changes), 0);
  assert.equal(db.prepare("SELECT payload FROM farms WHERE id = 'fa'").get().payload, "{}");
  db.close();
});
test("atomic count-and-insert enforces a plan farm limit", () => {
  const db = database();
  const create = db.prepare("INSERT INTO farms (id,owner_id,payload) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM farms WHERE owner_id = ?) < ?");
  assert.equal(Number(create.run("new1", "b", "{}", "b", 2).changes), 1);
  assert.equal(Number(create.run("new2", "b", "{}", "b", 2).changes), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM farms WHERE owner_id='b'").get().n, 2);
  db.close();
});
test("support replies append atomically without overwriting history", () => {
  const db = database();
  db.exec("INSERT INTO tickets (id,owner_id,payload) VALUES ('t','a','{\"subject\":\"Ajuda\",\"replies\":[]}')");
  const reply = db.prepare("UPDATE tickets SET payload = json_insert(json_patch(payload, ?), '$.replies[#]', json(?)) WHERE id = ? AND owner_id = ?");
  reply.run('{}', '{"message":"Primeira"}', "t", "a");
  reply.run('{"status":"respondido"}', '{"message":"Segunda"}', "t", "a");
  db.prepare("UPDATE tickets SET payload = json_patch(payload, ?) WHERE id = ? AND owner_id = ?").run('{"subject":"Dúvida atualizada","message":"Mais informações"}', "t", "a");
  const payload = JSON.parse(db.prepare("SELECT payload FROM tickets WHERE id='t'").get().payload);
  assert.deepEqual(payload.replies.map((r) => r.message), ["Primeira", "Segunda"]);
  assert.equal(payload.status, "respondido");
  db.close();
});
test("account deletion removes linked personal records and preserves the other tenant", () => {
  const db = database();
  db.exec("INSERT INTO plots (id,owner_id,farm_id,payload) VALUES ('pa','a','fa','{}')");
  db.exec("INSERT INTO seasons (id,owner_id,payload) VALUES ('sa','a','{}')");
  db.exec("INSERT INTO expenses (id,owner_id,farm_id,plot_id,season_id,payload) VALUES ('ea','a','fa','pa','sa','{}')");
  db.exec("INSERT INTO productions (id,owner_id,farm_id,plot_id,season_id,payload) VALUES ('pa1','a','fa','pa','sa','{}')");
  db.exec("INSERT INTO tickets (id,owner_id,payload) VALUES ('ta','a','{}')");
  db.exec("BEGIN");
  for (const table of ["expenses", "productions", "revenues", "plots", "farms", "seasons", "tickets"]) db.prepare(`DELETE FROM ${table} WHERE owner_id = ?`).run("a");
  for (const table of ["contacts", "crm", "payments", "subscriptions", "events"]) db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run("a");
  db.prepare("DELETE FROM profiles WHERE id = ?").run("a");
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE id='a'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE id='b'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM farms WHERE owner_id='a'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM farms WHERE owner_id='b'").get().n, 1);
  db.close();
});
