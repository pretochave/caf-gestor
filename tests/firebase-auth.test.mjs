import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createNativeD1 } from './helpers/native-d1.mjs';
registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); } catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context); throw error; } } });
const { firebaseAuthStatus, handleFirebaseAuthRequest, getFirebaseAppUser, prepareFirebaseIdentityDeletion, deleteFirebaseIdentity } = await import('../lib/firebase-auth.ts');
const config = { AUTH_PROVIDER: 'firebase', SITE_URL: 'https://cafegestor.test', BETTER_AUTH_SECRET: 'test-only-firebase-session-secret-never-a-real-credential', FIREBASE_API_KEY: 'firebase_fixture_key_not_a_real_credential', FIREBASE_PROJECT_ID: 'cafegestor-fixture' };
const password = 'fixture-password-123!';
const newPassword = 'replacement-fixture-456!';
const toBase64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function fixture() {
  const database = createNativeD1();
  const users = new Map(), tokens = new Map(), refreshTokens = new Map(), codes = new Map(), mails = [], calls = [];
  let sequence = 0, mailFailure = false, unavailable = false, wrongAudience = false;
  const error = (message, status = 400) => Response.json({ error: { message } }, { status });
  function issue(user) {
    const idToken = toBase64({ alg: 'RS256' }) + '.' + toBase64({ aud: wrongAudience ? 'other-project' : config.FIREBASE_PROJECT_ID, iss: 'https://securetoken.google.com/' + config.FIREBASE_PROJECT_ID, sub: user.localId, auth_time: user.authTime, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.fixture' + ++sequence;
    const refreshToken = 'fixture-refresh-' + sequence;
    tokens.set(idToken, user.localId);
    refreshTokens.set(refreshToken, { uid: user.localId, revision: user.revision });
    return { localId: user.localId, idToken, refreshToken, email: user.email, expiresIn: '3600' };
  }
  const findUser = token => users.get(tokens.get(token));
  const fetcher = async (input, init) => {
    const url = new URL(input), body = init.headers['Content-Type'].startsWith('application/json') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    const endpoint = url.hostname === 'securetoken.googleapis.com' ? 'refresh' : url.pathname.split(':')[1];
    calls.push({ url, endpoint, body, init });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (unavailable) throw new Error('provider detail and credential ' + config.FIREBASE_API_KEY);
    if (endpoint === 'signUp') {
      if ([...users.values()].some(user => user.email === body.email)) return error('EMAIL_EXISTS');
      const user = { localId: 'uid-' + ++sequence, email: body.email, password: body.password, displayName: '', emailVerified: false, disabled: false, revision: 1, passwordUpdatedAt: Date.now() - 3000, authTime: Math.floor(Date.now() / 1000) };
      users.set(user.localId, user);
      return Response.json(issue(user));
    }
    if (endpoint === 'signInWithPassword') {
      const user = [...users.values()].find(user => user.email === body.email && user.password === body.password);
      if (!user) return error('INVALID_LOGIN_CREDENTIALS');
      if (user.disabled) return error('USER_DISABLED');
      user.authTime = Math.floor(Date.now() / 1000);
      return Response.json(issue(user));
    }
    if (endpoint === 'lookup') {
      const user = findUser(body.idToken);
      if (!user || user.disabled) return error('INVALID_ID_TOKEN');
      const { password: ignoredPassword, revision: ignoredRevision, authTime: ignoredAuthTime, ...publicUser } = user;
      return Response.json({ users: [publicUser] });
    }
    if (endpoint === 'refresh') {
      assert.equal(body.grant_type, 'refresh_token');
      const old = refreshTokens.get(body.refresh_token), user = users.get(old?.uid);
      if (!user || user.disabled || user.revision !== old.revision) return error('TOKEN_EXPIRED');
      const issued = issue(user);
      return Response.json({ id_token: issued.idToken, refresh_token: issued.refreshToken, expires_in: '3600', user_id: user.localId, project_id: config.FIREBASE_PROJECT_ID });
    }
    if (endpoint === 'update') {
      if (body.oobCode) {
        const action = codes.get(body.oobCode);
        if (!action || action.kind !== 'VERIFY_EMAIL') return error('INVALID_OOB_CODE');
        const user = users.get(action.uid);
        if (!user || user.disabled) return error('USER_DISABLED');
        codes.delete(body.oobCode); user.emailVerified = true;
        return Response.json({ localId: user.localId, email: user.email, emailVerified: true });
      }
      const user = findUser(body.idToken);
      if (!user) return error('INVALID_ID_TOKEN');
      user.displayName = body.displayName;
      return Response.json(issue(user));
    }
    if (endpoint === 'sendOobCode') {
      if (mailFailure) return error('QUOTA_EXCEEDED', 503);
      assert.equal(init.headers['X-Firebase-Locale'], 'pt-BR');
      assert.equal(body.canHandleCodeInApp, false);
      assert.equal(new URL(body.continueUrl).origin, config.SITE_URL);
      const user = body.idToken ? findUser(body.idToken) : [...users.values()].find(user => user.email === body.email);
      if (!user) return Response.json({}); // Enumeration protection is enabled.
      const code = 'fixture-action-code-' + ++sequence;
      codes.set(code, { uid: user.localId, kind: body.requestType });
      mails.push({ email: user.email, code, kind: body.requestType });
      return Response.json({ email: user.email });
    }
    if (endpoint === 'resetPassword') {
      const action = codes.get(body.oobCode), user = users.get(action?.uid);
      if (!action || !user) return error('INVALID_OOB_CODE');
      if (body.newPassword) {
        if (action.kind !== 'PASSWORD_RESET') return error('INVALID_OOB_CODE');
        codes.delete(body.oobCode); user.password = body.newPassword; user.passwordUpdatedAt = Date.now() + 1; user.revision++;
      }
      return Response.json({ email: user.email, requestType: action.kind });
    }
    if (endpoint === 'delete') {
      const user = findUser(body.idToken);
      if (!user) return error('INVALID_ID_TOKEN');
      users.delete(user.localId);
      return Response.json({});
    }
    throw new Error('Unexpected fixture endpoint ' + endpoint);
  };
  const options = { fetcher };
  const request = (path, body, { cookie, origin = config.SITE_URL, extraHeaders = {}, method = 'POST', override = {} } = {}) => handleFirebaseAuthRequest({ ...config, ...override }, database.db, new Request(config.SITE_URL + '/api/auth' + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin, 'cf-connecting-ip': '192.0.2.51', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), options);
  const userFor = email => [...users.values()].find(user => user.email === email);
  const cookieFor = response => response.headers.get('set-cookie')?.split(';')[0];
  const signup = email => request('/sign-up/email', { email, name: 'Ana Produtora', password });
  const confirm = email => request('/verify-email', { oobCode: mails.findLast(mail => mail.email === email && mail.kind === 'VERIFY_EMAIL').code });
  const login = (email, other = {}) => request('/sign-in/email', { email, password, rememberMe: true, ...other });
  const ageMailCooldowns = () => database.native.exec('UPDATE auth_mail_cooldowns SET last_sent_at=last_sent_at-61');
  return { ...database, users, calls, mails, codes, options, fetcher, request, signup, confirm, login, cookieFor, userFor, ageMailCooldowns, setMailFailure(value) { mailFailure = value; }, setUnavailable(value) { unavailable = value; }, setWrongAudience(value) { wrongAudience = value; } };
}

test('Firebase configuration reports only required server settings and never exposes their values', () => {
  assert.deepEqual(firebaseAuthStatus(config).missing, []);
  assert.equal(firebaseAuthStatus(config).verificationMethod, 'link');
  const status = firebaseAuthStatus({ ...config, FIREBASE_API_KEY: undefined });
  assert.deepEqual(status.missing, ['FIREBASE_API_KEY']);
  assert.equal(status.configured, false);
  assert.equal(JSON.stringify(firebaseAuthStatus(config)).includes(config.FIREBASE_API_KEY), false);
});

test('real REST contract signs up, sends verification, denies pending access, verifies and creates a protected opaque session', async () => {
  const f = fixture();
  try {
    const signed = await f.signup('ana@example.test');
    assert.equal(signed.status, 200);
    assert.deepEqual(await signed.json(), { success: true, verificationRequired: true, email: 'ana@example.test' });
    const pending = f.cookieFor(signed);
    assert.match(signed.headers.get('set-cookie'), /__Host-cafegestor\.firebase_session=.+; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=900/);
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: pending }), f.options), null);
    const denied = await f.login('ana@example.test');
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'EMAIL_NOT_VERIFIED');
    assert.equal((await f.confirm('ana@example.test')).status, 200);
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: pending }), f.options), null);
    const logged = await f.login('ana@example.test');
    assert.equal(logged.status, 200);
    const body = await logged.json();
    assert.equal(body.user.id, 'firebase:cafegestor-fixture:' + f.userFor('ana@example.test').localId);
    assert.equal(body.user.emailVerified, true);
    const tokenCookie = f.cookieFor(logged);
    const user = await getFirebaseAppUser(config, f.db, new Headers({ Cookie: tokenCookie }), f.options);
    assert.equal(user.userId, body.user.id);
    assert.ok(f.calls.some(call => call.endpoint === 'refresh'));
    const persisted = JSON.stringify(f.native.prepare('SELECT * FROM firebase_sessions').all());
    assert.equal(persisted.includes(password), false);
    assert.equal(persisted.includes(tokenCookie.split('=')[1]), false);
    assert.equal(persisted.includes('fixture-refresh-'), false);
    assert.equal(persisted.includes(toBase64({ alg: 'RS256' })), false);
    assert.equal(JSON.stringify(body).includes('idToken'), false);
    assert.equal(JSON.stringify(body).includes('refreshToken'), false);
  } finally { f.close(); }
});

test('resend requires the pending cookie or password, enforces persistent cooldown, and preserves the existing action code', async () => {
  const f = fixture();
  try {
    const signed = await f.signup('ana@example.test'), pending = f.cookieFor(signed), firstCode = f.mails[0].code;
    const limited = await f.request('/send-verification-email', { email: 'ana@example.test' }, { cookie: pending });
    assert.equal(limited.status, 429); assert.equal(f.mails.length, 1); assert.ok(f.codes.has(firstCode));
    f.ageMailCooldowns();
    assert.equal((await f.request('/send-verification-email', { email: 'ana@example.test' })).status, 401);
    assert.equal((await f.request('/send-verification-email', { email: 'ana@example.test', password: 'incorrect' })).status, 401);
    assert.equal((await f.request('/send-verification-email', { email: 'ana@example.test' }, { cookie: pending })).status, 200);
    assert.equal(f.mails.length, 2);
    await f.confirm('ana@example.test'); f.ageMailCooldowns();
    const already = await f.request('/send-verification-email', { email: 'ana@example.test' }, { cookie: pending });
    assert.equal(already.status, 409); assert.equal((await already.json()).code, 'EMAIL_IS_ALREADY_VERIFIED');
  } finally { f.close(); }
});

test('Firebase unavailable, mail failure and missing config never report a fake successful signup or leak credentials', async () => {
  const f = fixture();
  try {
    f.setMailFailure(true);
    const mailFailed = await f.signup('ana@example.test');
    assert.equal(mailFailed.status, 503); assert.equal((await mailFailed.json()).code, 'EMAIL_DELIVERY_UNAVAILABLE');
    assert.equal(f.native.prepare('SELECT COUNT(*) AS count FROM firebase_sessions').get().count, 0);
    f.setUnavailable(true);
    const unavailable = await f.login('ana@example.test');
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.text()).includes(config.FIREBASE_API_KEY), false);
    const prior = f.calls.length;
    const unconfigured = await f.request('/sign-up/email', { email: 'bia@example.test', name: 'Bia', password }, { override: { FIREBASE_API_KEY: undefined } });
    assert.equal(unconfigured.status, 503); assert.equal(f.calls.length, prior);
  } finally { f.close(); }
});

test('logout invalidates cookie replay, and disabled users or externally reset credentials lose all private access', async () => {
  const f = fixture();
  try {
    await f.signup('ana@example.test'); await f.confirm('ana@example.test');
    const firstCookie = f.cookieFor(await f.login('ana@example.test'));
    const out = await f.request('/sign-out', {}, { cookie: firstCookie });
    assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: firstCookie }), f.options), null);
    const secondCookie = f.cookieFor(await f.login('ana@example.test'));
    f.userFor('ana@example.test').disabled = true;
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: secondCookie }), f.options), null);
    f.userFor('ana@example.test').disabled = false;
    const thirdCookie = f.cookieFor(await f.login('ana@example.test'));
    f.userFor('ana@example.test').revision++;
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: thirdCookie }), f.options), null);
  } finally { f.close(); }
});

test('password reset action is one-use, requires correct purpose, revokes sessions and rejects the previous password', async () => {
  const f = fixture();
  try {
    await f.signup('ana@example.test');
    const verifyCode = f.mails[0].code;
    const wrongPurpose = await f.request('/reset-password', { token: verifyCode, newPassword });
    assert.equal(wrongPurpose.status, 400); assert.ok(f.codes.has(verifyCode));
    await f.confirm('ana@example.test');
    const sessionCookie = f.cookieFor(await f.login('ana@example.test'));
    assert.equal((await f.request('/request-password-reset', { email: 'ana@example.test', redirectTo: 'https://attacker.example/' })).status, 200);
    const reset = f.mails.findLast(mail => mail.kind === 'PASSWORD_RESET');
    const wrongVerify = await f.request('/verify-email', { oobCode: reset.code });
    assert.equal(wrongVerify.status, 400); assert.ok(f.codes.has(reset.code));
    assert.equal((await f.request('/reset-password', { token: reset.code, newPassword })).status, 200);
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: sessionCookie }), f.options), null);
    assert.equal((await f.request('/reset-password', { token: reset.code, newPassword })).status, 400);
    assert.equal((await f.login('ana@example.test')).status, 401);
    assert.equal((await f.login('ana@example.test', { password: newPassword })).status, 200);
    assert.equal((await f.request('/request-password-reset', { email: 'unknown@example.test' })).status, 200);
  } finally { f.close(); }
});

test('server rejects forged identities, cross-site requests, wrong project claims, tampered cookies and tenant email matches', async () => {
  const f = fixture();
  try {
    const injected = await f.request('/sign-up/email', { email: 'ana@example.test', name: 'Ana', password, emailVerified: true, role: 'admin' });
    assert.equal(injected.status, 400); assert.equal(f.calls.length, 0);
    assert.equal((await f.request('/sign-in/email', { email: 'ana@example.test', password }, { origin: 'https://attacker.example' })).status, 403);
    const spoof = new Headers({ 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'admin@example.test' });
    assert.equal(await getFirebaseAppUser(config, f.db, spoof, f.options), null);
    await f.signup('ana@example.test'); await f.confirm('ana@example.test');
    f.setWrongAudience(true); assert.equal((await f.login('ana@example.test')).status, 401); f.setWrongAudience(false);
    const first = f.cookieFor(await f.login('ana@example.test'));
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: first.slice(0, -1) + (first.endsWith('a') ? 'b' : 'a') }), f.options), null);
    const originalOwner = (await getFirebaseAppUser(config, f.db, new Headers({ Cookie: first }), f.options)).userId;
    const user = f.userFor('ana@example.test'); f.users.delete(user.localId);
    f.ageMailCooldowns();
    await f.signup('ana@example.test'); await f.confirm('ana@example.test');
    const recreated = f.cookieFor(await f.login('ana@example.test'));
    assert.notEqual((await getFirebaseAppUser(config, f.db, new Headers({ Cookie: recreated }), f.options)).userId, originalOwner);
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: first }), f.options), null);
    assert.equal(await getFirebaseAppUser({ ...config, FIREBASE_PROJECT_ID: 'different-project' }, f.db, new Headers({ Cookie: recreated }), f.options), null);
  } finally { f.close(); }
});

test('expired or corrupted server sessions fail closed; transient provider outage preserves the session for retry', async () => {
  const f = fixture();
  try {
    await f.signup('ana@example.test'); await f.confirm('ana@example.test');
    const sessionCookie = f.cookieFor(await f.login('ana@example.test'));
    f.setUnavailable(true);
    await assert.rejects(getFirebaseAppUser(config, f.db, new Headers({ Cookie: sessionCookie }), f.options), { status: 503 });
    assert.equal(f.native.prepare("SELECT COUNT(*) AS count FROM firebase_sessions WHERE kind='authenticated'").get().count, 1);
    f.setUnavailable(false);
    assert.ok(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: sessionCookie }), f.options));
    f.native.exec("UPDATE firebase_sessions SET encrypted_tokens='tampered'");
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: sessionCookie }), f.options), null);
    const again = f.cookieFor(await f.login('ana@example.test'));
    f.native.exec('UPDATE firebase_sessions SET expires_at=unixepoch()-1');
    assert.equal(await getFirebaseAppUser(config, f.db, new Headers({ Cookie: again }), f.options), null);
  } finally { f.close(); }
});

test('identity deletion calls Firebase only for the authenticated owner and removes server sessions', async () => {
  const f = fixture();
  try {
    await f.signup('ana@example.test'); await f.confirm('ana@example.test');
    const sessionCookie = f.cookieFor(await f.login('ana@example.test')), headers = new Headers({ Cookie: sessionCookie });
    const user = await getFirebaseAppUser(config, f.db, headers, f.options);
    await assert.rejects(deleteFirebaseIdentity(config, f.db, headers, 'firebase:other-project:attacker', f.options), { status: 401 });
    assert.equal(f.calls.filter(call => call.endpoint === 'delete').length, 0);
    await deleteFirebaseIdentity(config, f.db, headers, user.userId, f.options);
    assert.equal(f.users.size, 0);
    assert.equal(await getFirebaseAppUser(config, f.db, headers, f.options), null);
  } finally { f.close(); }
});

test('prepared identity deletion preserves the account on D1 rollback and works after local sessions are committed away', async () => {
  const f = fixture();
  try {
    await f.signup('ana@example.test'); await f.confirm('ana@example.test');
    const sessionCookie = f.cookieFor(await f.login('ana@example.test')), headers = new Headers({ Cookie: sessionCookie });
    const user = await getFirebaseAppUser(config, f.db, headers, f.options);
    f.native.prepare('INSERT INTO profiles (id, name, email, email_verified) VALUES (?, ?, ?, 1)').run(user.userId, 'Ana', user.email);
    f.native.prepare('INSERT INTO farms (id, owner_id, payload) VALUES (?, ?, ?)').run('real-sqlite-farm', user.userId, JSON.stringify({ name: 'Fazenda da Ana' }));
    const deleteIdentity = await prepareFirebaseIdentityDeletion(config, f.db, headers, user.userId, f.options);
    assert.equal(f.calls.filter(call => call.endpoint === 'delete').length, 0);
    assert.equal(f.users.size, 1);

    await assert.rejects(f.db.batch([
      f.db.prepare('DELETE FROM firebase_sessions WHERE owner_id=?').bind(user.userId),
      f.db.prepare('DELETE FROM profiles WHERE id=?').bind(user.userId),
      f.db.prepare("INSERT INTO profiles (id, name, email, status) VALUES ('bad-row', 'Failure', 'failure@example.test', 'invalid-status')"),
    ]), /CHECK constraint failed/);
    assert.equal(f.users.size, 1);
    assert.equal(f.native.prepare('SELECT COUNT(*) AS count FROM farms').get().count, 1);
    assert.ok(await getFirebaseAppUser(config, f.db, headers, f.options));
    assert.equal(f.calls.filter(call => call.endpoint === 'delete').length, 0);

    await f.db.batch([
      f.db.prepare('DELETE FROM profiles WHERE id=?').bind(user.userId),
      f.db.prepare('DELETE FROM firebase_sessions WHERE owner_id=?').bind(user.userId),
    ]);
    assert.equal(f.native.prepare('SELECT COUNT(*) AS count FROM firebase_sessions').get().count, 0);
    assert.equal(f.native.prepare('SELECT COUNT(*) AS count FROM farms').get().count, 0);
    await deleteIdentity();
    assert.equal(f.users.size, 0);
    assert.equal(f.calls.filter(call => call.endpoint === 'delete').length, 1);
  } finally { f.close(); }
});

test('provider failure after committed local deletion remains retryable by signing in again', async () => {
  const f = fixture();
  try {
    await f.signup('ana@example.test'); await f.confirm('ana@example.test');
    const sessionCookie = f.cookieFor(await f.login('ana@example.test')), headers = new Headers({ Cookie: sessionCookie });
    const user = await getFirebaseAppUser(config, f.db, headers, f.options);
    const deleteIdentity = await prepareFirebaseIdentityDeletion(config, f.db, headers, user.userId, f.options);
    await f.db.batch([f.db.prepare('DELETE FROM firebase_sessions WHERE owner_id=?').bind(user.userId)]);
    f.setUnavailable(true);
    await assert.rejects(deleteIdentity(), error => error.status === 503 && !error.message.includes(config.FIREBASE_API_KEY));
    assert.equal(f.users.size, 1);
    assert.equal(f.native.prepare('SELECT COUNT(*) AS count FROM firebase_sessions').get().count, 0);
    f.setUnavailable(false);
    assert.equal((await f.login('ana@example.test')).status, 200);
  } finally { f.close(); }
});
