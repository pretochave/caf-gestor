import test from "node:test";
import assert from "node:assert/strict";
import { resolveCloudflareConfig, requireProductionConfig, ensureGeneratedMatches, localDatabaseId } from "../scripts/cloudflare-config.mjs";
import { independentRequest } from "../lib/standalone-request.mjs";

const account = "1234567890abcdef1234567890abcdef";
const database = "12345678-1234-4123-8123-123456789abc";
const fixture = () => ({ name: "cafegestor", main: "worker.cloudflare.ts", d1_databases: [{ binding: "DB", database_name: "cafegestor-db", database_id: localDatabaseId }] });
test("standalone public deployment rejects local placeholders and an unselected account", () => {
  assert.throws(() => requireProductionConfig(resolveCloudflareConfig({}, fixture())), /ACCOUNT_ID/);
  assert.throws(() => requireProductionConfig(resolveCloudflareConfig({ CLOUDFLARE_ACCOUNT_ID: account }, fixture())), /identificador local/);
  assert.throws(() => resolveCloudflareConfig({ CLOUDFLARE_ACCOUNT_ID: "wrong-account" }, fixture()), /ACCOUNT_ID inválido/);
  assert.throws(() => resolveCloudflareConfig({ CLOUDFLARE_D1_DATABASE_ID: "invented" }, fixture()), /UUID/);
});
test("environment selection is explicit and never mutates the tracked template", () => {
  const original = fixture();
  const resolved = resolveCloudflareConfig({ CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_D1_DATABASE_ID: database }, original);
  assert.equal(requireProductionConfig(resolved), resolved);
  assert.equal(resolved.account_id, account);
  assert.equal(resolved.d1_databases[0].database_id, database);
  assert.equal(original.d1_databases[0].database_id, localDatabaseId);
  assert.equal(original.account_id, undefined);
});
test("deploy cannot accidentally upload a build targeting another account or database", () => {
  const expected = resolveCloudflareConfig({ CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_D1_DATABASE_ID: database }, fixture());
  assert.doesNotThrow(() => ensureGeneratedMatches(expected, structuredClone(expected)));
  const wrong = structuredClone(expected); wrong.account_id = "abcdef1234567890abcdef1234567890";
  assert.throws(() => ensureGeneratedMatches(expected, wrong), /outro destino/);
  wrong.account_id = account; wrong.d1_databases[0].database_id = localDatabaseId;
  assert.throws(() => ensureGeneratedMatches(expected, wrong), /outro destino/);
});
test("public requests lose forged proxy identity while native cookies, CSRF and webhook signatures survive", async () => {
  const original = new Request("https://cafegestor.example/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "oai-authenticated-user-id": "owner-id",
      "OAI-Authenticated-User-Email": "admin@example.com",
      "oai-authenticated-user-full-name": "Forged administrator",
      "cookie": "cafegestor.session_token=native-session",
      "origin": "https://cafegestor.example",
      "stripe-signature": "unmodified-provider-signature",
      "content-type": "application/json",
    },
    body: '{"email":"producer@example.com"}',
  });
  const forwarded = independentRequest(original);
  assert.equal(forwarded.headers.get("oai-authenticated-user-id"), null);
  assert.equal(forwarded.headers.get("oai-authenticated-user-email"), null);
  assert.equal(forwarded.headers.get("oai-authenticated-user-full-name"), null);
  assert.equal(original.headers.get("oai-authenticated-user-id"), "owner-id");
  assert.equal(forwarded.headers.get("cookie"), "cafegestor.session_token=native-session");
  assert.equal(forwarded.headers.get("origin"), "https://cafegestor.example");
  assert.equal(forwarded.headers.get("stripe-signature"), "unmodified-provider-signature");
  assert.equal(forwarded.method, "POST");
  assert.equal(await forwarded.text(), '{"email":"producer@example.com"}');
});
