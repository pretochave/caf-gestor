import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as FixtureResponse } from 'miniflare';

test('Cloudflare runtime can call credential providers and never follows their redirects', { timeout: 30_000 }, async () => {
  const config = {
    AUTH_PROVIDER: 'firebase', SITE_URL: 'https://cafegestor.test',
    BETTER_AUTH_SECRET: 'fixture-only-session-secret-for-worker-runtime',
    FIREBASE_API_KEY: 'fixture_only_public_project_key_for_worker_test',
    FIREBASE_PROJECT_ID: 'cafegestor-fixture',
    RESEND_API_KEY: 're_fixture_only_mail_key_for_worker_test',
    EMAIL_FROM: 'CaféGestor <fixture@cafegestor.test>',
    STRIPE_SECRET_KEY: 'sk_test_fixture_only_worker_runtime',
  };
  const bundle = await build({
    stdin: {
      contents: `
        import { handleFirebaseAuthRequest } from './lib/firebase-auth.ts';
        import { resendMailer, verificationMail } from './lib/auth-mail.ts';
        import { stripeRequest } from './lib/billing.ts';
        const config = ${JSON.stringify(config)};
        export default { async fetch(request, env) {
          try {
            const path = new URL(request.url).pathname;
            if (path === '/fixture/resend') {
              await resendMailer(config)(verificationMail('fixture@example.test', '123456'));
              return Response.json({ accepted: true });
            }
            if (path === '/fixture/stripe') {
              const result = await stripeRequest(config, '/v1/customers', new URLSearchParams({name:'Fixture'}), 'fixture-idempotency');
              return Response.json(result);
            }
            return handleFirebaseAuthRequest(config, env.DB, request);
          } catch (error) {
            return Response.json({ code: error.code, message: error.message }, {status: error.status || 500});
          }
        }};
      `,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      sourcefile: 'provider-runtime-fixture.ts', loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  const outbound = [];
  let redirectUpstream = false;
  const runtime = new Miniflare({
    modules: true, compatibilityDate: '2026-05-22', script: bundle.outputFiles[0].text,
    d1Databases: { DB: 'provider-runtime-fixture' },
    // Every outbound request is intercepted locally; no real provider is contacted.
    outboundService: async request => {
      const url = new URL(request.url);
      outbound.push(url.hostname);
      if (redirectUpstream) return new FixtureResponse(null, { status: 307, headers: { Location: 'https://credential-leak.invalid/' } });
      if (url.hostname === 'identitytoolkit.googleapis.com') return FixtureResponse.json({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }, { status: 400 });
      if (url.hostname === 'api.resend.com') return FixtureResponse.json({ id: 'fixture-mail-receipt' });
      if (url.hostname === 'api.stripe.com') return FixtureResponse.json({ id: 'cus_fixture' });
      throw new Error('Unexpected outbound fixture destination');
    },
  });
  try {
    const db = await runtime.getD1Database('DB');
    const migrations = new URL('../drizzle/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      const statements = (await readFile(new URL(name, migrations), 'utf8')).split('--> statement-breakpoint').map(sql => sql.trim()).filter(Boolean);
      await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const login = () => runtime.dispatchFetch(config.SITE_URL + '/api/auth/sign-in/email', {
      method: 'POST', headers: { Origin: config.SITE_URL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fixture@example.test', password: 'fixture-password-123' }),
    });
    const requests = [login, () => runtime.dispatchFetch(config.SITE_URL + '/fixture/resend'), () => runtime.dispatchFetch(config.SITE_URL + '/fixture/stripe')];
    const expectedHosts = ['identitytoolkit.googleapis.com', 'api.resend.com', 'api.stripe.com'];
    for (let index = 0; index < requests.length; index++) {
      const response = await requests[index]();
      assert.equal(response.status, index === 0 ? 401 : 200);
      assert.equal(outbound.length, index + 1);
      assert.equal(outbound[index], expectedHosts[index]);
    }
    redirectUpstream = true;
    for (const request of requests) {
      const count = outbound.length;
      const response = await request();
      assert.ok(response.status >= 500);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(outbound.length, count + 1, 'credential-bearing redirect must not be followed');
      assert.equal((await response.text()).includes('credential-leak.invalid'), false);
    }
    assert.equal(outbound.includes('credential-leak.invalid'), false);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM firebase_sessions').first()).count, 0);
  } finally { await runtime.dispose(); }
});
