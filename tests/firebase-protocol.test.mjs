import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createNativeD1 } from './helpers/native-d1.mjs';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { handleFirebaseAuthRequest } = await import('../lib/firebase-auth.ts');
const config = {
  AUTH_PROVIDER: 'firebase', SITE_URL: 'https://cafegestor.test',
  BETTER_AUTH_SECRET: 'fixture-only-session-secret-for-protocol-validation',
  FIREBASE_API_KEY: 'fixture_only_public_project_key_for_protocol_test',
  FIREBASE_PROJECT_ID: 'cafegestor-fixture',
};

test('malformed provider responses fail closed without creating a session or disclosing provider details', async () => {
  const responses = [
    () => Response.json(null),
    () => Response.json([]),
    () => Response.json({ error: { message: 'private upstream detail ' + config.FIREBASE_API_KEY } }),
    () => new Response('<html>upstream gateway error</html>', { status: 200 }),
  ];
  for (const response of responses) {
    const database = createNativeD1();
    try {
      const result = await handleFirebaseAuthRequest(config, database.db, new Request(config.SITE_URL + '/api/auth/sign-in/email', {
        method: 'POST', headers: { Origin: config.SITE_URL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'fixture@example.test', password: 'fixture-password-123' }),
      }), { fetcher: async () => response() });
      assert.equal(result.status, 503);
      assert.equal(result.headers.get('set-cookie'), null);
      const body = await result.text();
      assert.equal(body.includes(config.FIREBASE_API_KEY), false);
      assert.equal(body.includes('private upstream detail'), false);
      assert.equal(database.native.prepare('SELECT COUNT(*) AS count FROM firebase_sessions').get().count, 0);
    } finally { database.close(); }
  }
});
