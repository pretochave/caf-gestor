import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createNativeD1 } from './helpers/native-d1.mjs';
registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context); throw error; } } });
const { resendMailer, verificationMail, resetMail } = await import('../lib/auth-mail.ts');
const { authOrigin, nativeAuthStatus, verifiedAdministrator, consumeAuthLimit, reserveAuthMail, assertMailCooldown, cleanupExpiredAuthGuards, secretDigest, verificationIdentifier } = await import('../lib/auth-policy.ts');
const config = { SITE_URL: 'https://cafegestor.test', BETTER_AUTH_SECRET: 'test-only-native-auth-secret-with-64characters-for-fixtures', RESEND_API_KEY: 're_mock_test_key_not_a_real_credential', EMAIL_FROM: 'CaféGestor <acesso@cafegestor.test>' };

test('Resend sends the real API request with server-only credentials and checks its receipt', async () => {
  let observed;
  const fetcher = async (url, init) => { observed = { url, init }; return Response.json({ id: 'accepted-fixture-id' }); };
  const mail = verificationMail('ana@cafegestor.test', '483927');
  await resendMailer(config, fetcher)(mail);
  assert.equal(observed.url, 'https://api.resend.com/emails');
  assert.equal(observed.init.method, 'POST');
  assert.equal(observed.init.headers.Authorization, 'Bearer ' + config.RESEND_API_KEY);
  assert.match(observed.init.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/);
  assert.equal(observed.init.redirect, 'error');
  assert.ok(observed.init.signal instanceof AbortSignal);
  const body = JSON.parse(observed.init.body);
  assert.equal(body.from, config.EMAIL_FROM);
  assert.deepEqual(body.to, [mail.to]);
  assert.match(body.text, /483927/);
  assert.match(body.text, /10 minutos/);
  assert.equal(observed.init.body.includes(config.RESEND_API_KEY), false);
  assert.equal(observed.init.body.includes(config.BETTER_AUTH_SECRET), false);
});

test('provider failures and incomplete responses fail honestly without exposing provider details', async () => {
  for (const fetcher of [async () => Response.json({ secret: config.RESEND_API_KEY }, { status: 403 }), async () => Response.json({}), async () => new Response('not json'), async () => { throw Error('socket detail ' + config.RESEND_API_KEY); }]) {
    await assert.rejects(resendMailer(config, fetcher)(verificationMail('ana@cafegestor.test', '483927')), error => error.status === 503 && error.code === 'EMAIL_DELIVERY_UNAVAILABLE' && !error.message.includes(config.RESEND_API_KEY));
  }
  let called = false;
  await assert.rejects(resendMailer({ ...config, RESEND_API_KEY: undefined }, async () => { called = true; return Response.json({ id: 'bad' }); })(verificationMail('ana@cafegestor.test', '483927')), { status: 503, code: 'EMAIL_NOT_CONFIGURED' });
  assert.equal(called, false);
});

test('auth configuration validates HTTPS and reports only missing key names', () => {
  assert.equal(nativeAuthStatus(config).configured, true);
  assert.equal(JSON.stringify(nativeAuthStatus(config)).includes(config.RESEND_API_KEY), false);
  assert.equal(nativeAuthStatus({ ...config, EMAIL_FROM: 'CaféGestor <a@b.test>\r\nBcc: victim@test.test' }).mailConfigured, false);
  assert.equal(nativeAuthStatus({ ...config, BETTER_AUTH_SECRET: 'short' }).configured, false);
  assert.equal(nativeAuthStatus(config, false).configured, false);
  for (const url of ['http://public.test', 'https://user:password@public.test', 'https://public.test/path', 'https://public.test?key=x']) assert.throws(() => authOrigin({ ...config, SITE_URL: url }), { status: 503 });
  assert.equal(authOrigin({ ...config, SITE_URL: 'http://127.0.0.1:5173' }), 'http://127.0.0.1:5173');
});

test('administrator email alone cannot grant administration before verification', () => {
  assert.equal(verifiedAdministrator('OWNER@cafegestor.test', true, 'owner@cafegestor.test'), true);
  assert.equal(verifiedAdministrator('owner@cafegestor.test', false, 'owner@cafegestor.test'), false);
  assert.equal(verifiedAdministrator('other@cafegestor.test', true, 'owner@cafegestor.test'), false);
  assert.equal(verifiedAdministrator('owner@cafegestor.test', true, undefined), false);
});

test('persistent rate counters and cooldowns remain atomic across concurrent requests', async () => {
  const f = createNativeD1();
  try {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => consumeAuthLimit(f.db, 'independent-limit', 5, 60)));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 5);
    assert.equal(f.native.prepare("SELECT count FROM auth_request_limits WHERE key='independent-limit'").get().count, 5);
    f.native.exec("UPDATE auth_request_limits SET window_start=unixepoch()-61");
    await consumeAuthLimit(f.db, 'independent-limit', 5, 60);
    assert.equal(f.native.prepare("SELECT count FROM auth_request_limits WHERE key='independent-limit'").get().count, 1);
    const mail = await Promise.allSettled(Array.from({ length: 5 }, () => reserveAuthMail(f.db, 'independent-mail')));
    assert.equal(mail.filter(x => x.status === 'fulfilled').length, 1);
    await assert.rejects(assertMailCooldown(f.db, 'independent-mail'), { status: 429 });
    f.native.exec("UPDATE auth_mail_cooldowns SET last_sent_at=unixepoch()-61");
    await assertMailCooldown(f.db, 'independent-mail');
    await reserveAuthMail(f.db, 'independent-mail');
  } finally { f.close(); }
});

test('bounded maintenance removes expired guard entries while preserving active limits', async () => {
  const f = createNativeD1();
  try {
    f.native.exec("INSERT INTO auth_request_limits VALUES('expired',1,0,0),('active',2,unixepoch(),unixepoch()+60)");
    f.native.exec("INSERT INTO auth_operation_locks VALUES('expired','token',0),('active','token',unixepoch()+120)");
    f.native.exec("INSERT INTO auth_mail_cooldowns VALUES('expired',0),('active',unixepoch())");
    await cleanupExpiredAuthGuards(f.db);
    for (const table of ['auth_request_limits', 'auth_operation_locks', 'auth_mail_cooldowns']) assert.deepEqual(f.native.prepare('SELECT key FROM ' + table).all().map(x => x.key), ['active']);
  } finally { f.close(); }
});

test('verification identifiers and guard keys are bound to server secret and mail links are escaped', async () => {
  const id = await verificationIdentifier(config, 'reset-password:token-fixture');
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.notEqual(id, await verificationIdentifier({ ...config, BETTER_AUTH_SECRET: 'a-different-test-only-secret-more-than32characters' }, 'reset-password:token-fixture'));
  assert.notEqual(id, await secretDigest(config, 'reset-password:token-fixture'));
  const mail = resetMail('ana@cafegestor.test', 'https://cafegestor.test/reset?token=one&next=two');
  assert.match(mail.html, /token=one&amp;next=two/);
  assert.match(mail.text, /30 minutos/);
});
