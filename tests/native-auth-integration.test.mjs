import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createNativeD1 } from './helpers/native-d1.mjs';

// Match TypeScript bundler resolution while exercising the original server implementation.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});
const { handleAuthRequest } = await import('../lib/auth-core.ts');

const origin = 'https://cafegestor.test';
const configuration = {
  SITE_URL: origin,
  BETTER_AUTH_SECRET: 'test-only-independent-auth-secret-with-more-than-32-characters',
  RESEND_API_KEY: 're_independent_test_transport',
  EMAIL_FROM: 'CaféGestor <conta@cafegestor.test>',
  ADMIN_EMAIL: 'owner@cafegestor.test',
};
const password = 'Uma-senha-de-teste-42!';

function fixture(config = configuration, injectMailer = true) {
  const sqlite = createNativeD1();
  const mails = [];
  const cookies = new Map();
  async function request(path, body, extra = {}) {
    const headers = new Headers({
      origin,
      'cf-connecting-ip': '203.0.113.42',
      ...extra.headers,
    });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (cookies.size && !extra.anonymous) headers.set('cookie', [...cookies].map(([key, value]) => key + '=' + value).join('; '));
    const response = await handleAuthRequest(config, sqlite.db, new Request(origin + '/api/auth' + path, {
      method: extra.method || (body === undefined ? 'GET' : 'POST'), headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }), injectMailer ? { mailer: typeof injectMailer === 'function' ? injectMailer : async mail => { mails.push(mail); } } : {});
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], index = pair.indexOf('=');
      const key = pair.slice(0, index), value = pair.slice(index + 1);
      if (!value || /max-age=0/i.test(cookie)) cookies.delete(key);
      else cookies.set(key, value);
    }
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    return { response, status: response.status, data, raw };
  }
  function otp() {
    const mail = [...mails].reverse().find(mail => /\b\d{6}\b/.test(JSON.stringify(mail)));
    assert.ok(mail, 'The test-only mail transport must receive an actual verification message');
    return JSON.stringify(mail).match(/\b\d{6}\b/)[0];
  }
  async function signUp(email = 'ana@cafegestor.test') {
    const result = await request('/sign-up/email', { name: 'Ana do teste independente', email, password });
    assert.ok(result.status < 300, 'Signup failed: ' + result.raw);
    return { email, code: otp() };
  }
  async function verifiedLogin(email = 'ana@cafegestor.test') {
    const signup = await signUp(email);
    const verification = await request('/email-otp/verify-email', { email, otp: signup.code });
    assert.ok(verification.status < 300, 'Verification failed: ' + verification.raw);
    const login = await request('/sign-in/email', { email, password });
    assert.ok(login.status < 300, 'Login failed: ' + login.raw);
    return { email, login };
  }
  return { ...sqlite, config, mails, cookies, request, otp, signUp, verifiedLogin };
}

test('native auth ignores forged OpenAI identity headers and rejects cross-site mutations', async () => {
  const f = fixture();
  try {
    const session = await f.request('/get-session', undefined, { headers: {
      'oai-authenticated-user-id': 'forged-owner',
      'oai-authenticated-user-email': configuration.ADMIN_EMAIL,
    } });
    assert.equal(session.status, 200);
    assert.equal(session.data, null);
    const attack = await f.request('/sign-up/email', { name: 'Ataque', email: 'other@cafegestor.test', password }, { headers: { origin: 'https://evil.test' } });
    assert.equal(attack.status, 403);
    assert.equal(f.mails.length, 0);
  } finally { f.close(); }
});

test('public endpoints reject privilege injection, alternative OTP sign-in, and external reset redirects', async () => {
  const f = fixture();
  try {
    const injected = await f.request('/sign-up/email', { name: 'Injeção', email: configuration.ADMIN_EMAIL, password, emailVerified: true, role: 'admin' });
    assert.equal(injected.status, 400);
    const unwantedLogin = await f.request('/sign-in/email-otp', { email: configuration.ADMIN_EMAIL, otp: '000000' });
    assert.equal(unwantedLogin.status, 404);
    const wrongPurpose = await f.request('/email-otp/send-verification-otp', { email: configuration.ADMIN_EMAIL, type: 'sign-in' });
    assert.equal(wrongPurpose.status, 400);
    const redirect = await f.request('/request-password-reset', { email: configuration.ADMIN_EMAIL, redirectTo: 'https://evil.test/collect-token' });
    assert.equal(redirect.status, 400);
    assert.equal(f.mails.length, 0);
  } finally { f.close(); }
});

test('signup sends an OTP, denies login before activation, and stores no plaintext password or code', async () => {
  const f = fixture();
  try {
    const { email, code } = await f.signUp();
    const denied = await f.request('/sign-in/email', { email, password });
    assert.equal(denied.status, 403);
    const session = await f.request('/get-session');
    assert.equal(session.data, null);
    const tables = f.native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      const rows = f.native.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all();
      const contents = JSON.stringify(rows);
      assert.equal(contents.includes(password), false, `Plaintext password found in ${name}`);
      const plaintextCode = rows.some(row => Object.values(row).some(value => typeof value === 'string' && (value === code || value.startsWith(code + ':') || value.startsWith(code + '.'))));
      assert.equal(plaintextCode, false, `Plaintext OTP found in ${name}`);
    }
  } finally { f.close(); }
});

test('verified email and password create an HttpOnly secure session that logout revokes', async () => {
  const f = fixture();
  try {
    const { email, login } = await f.verifiedLogin();
    const cookieHeaders = login.response.headers.getSetCookie();
    assert.ok(cookieHeaders.some(cookie => /httponly/i.test(cookie) && /secure/i.test(cookie) && /samesite=lax/i.test(cookie)));
    const session = await f.request('/get-session');
    assert.equal(session.data.user.email, email);
    assert.equal(session.data.user.emailVerified, true);
    const capturedCookies = new Map(f.cookies);
    const logout = await f.request('/sign-out', {});
    assert.ok(logout.status < 300);
    f.cookies.clear();
    for (const [key, value] of capturedCookies) f.cookies.set(key, value);
    const replay = await f.request('/get-session');
    assert.equal(replay.data, null, 'An old cookie must not remain valid after logout');
  } finally { f.close(); }
});

test('resend cooldown is persisted across requests and concurrent resends cannot send a burst', async () => {
  const f = fixture();
  try {
    const { email } = await f.signUp();
    const before = f.mails.length;
    const resends = await Promise.all(Array.from({ length: 6 }, () => f.request('/email-otp/send-verification-otp', { email, type: 'email-verification' })));
    assert.ok(resends.every(result => result.status === 429));
    assert.ok(resends.every(result => Number(result.response.headers.get('Retry-After')) > 0));
    assert.equal(f.mails.length, before);
  } finally { f.close(); }
});

test('a resend rejected by the cooldown preserves the code that was already delivered', async () => {
  const f = fixture();
  try {
    const { email, code } = await f.signUp();
    const resend = await f.request('/email-otp/send-verification-otp', { email, type: 'email-verification' });
    assert.equal(resend.status, 429);
    const verified = await f.request('/email-otp/verify-email', { email, otp: code });
    assert.ok(verified.status < 300, 'The rejected resend invalidated the original code: ' + verified.raw);
    assert.ok((await f.request('/sign-in/email', { email, password })).status < 300);
  } finally { f.close(); }
});

test('five incorrect OTP attempts invalidate the original code and cannot activate the account', async () => {
  const f = fixture();
  try {
    const { email, code } = await f.signUp();
    const incorrect = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await f.request('/email-otp/verify-email', { email, otp: incorrect });
      assert.ok(response.status >= 400 && response.status < 500);
    }
    const exhausted = await f.request('/email-otp/verify-email', { email, otp: code });
    assert.ok(exhausted.status >= 400 && exhausted.status < 500);
    const session = await f.request('/get-session');
    assert.equal(session.data, null);
  } finally { f.close(); }
});

test('expired OTP cannot activate an account', async () => {
  const f = fixture();
  try {
    const { email, code } = await f.signUp();
    const tables = f.native.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    let expired = 0;
    for (const { name } of tables) {
      const escaped = '"' + name.replaceAll('"', '""') + '"';
      const columns = f.native.prepare('PRAGMA table_info(' + escaped + ')').all().map(column => column.name);
      const expiryColumn = columns.find(column => column.replaceAll('_', '').toLowerCase() === 'expiresat');
      if (expiryColumn && columns.includes('identifier')) {
        f.native.exec('UPDATE ' + escaped + ' SET "' + expiryColumn + '" = 0');
        expired++;
      }
    }
    assert.ok(expired, 'The real verification storage must expose expiring records');
    const verification = await f.request('/email-otp/verify-email', { email, otp: code });
    assert.ok(verification.status >= 400 && verification.status < 500);
    assert.equal((await f.request('/get-session')).data, null);
  } finally { f.close(); }
});

test('password reset uses a one-time link and revokes sessions issued before the reset', async () => {
  const f = fixture();
  try {
    const { email } = await f.verifiedLogin();
    const oldCookies = new Map(f.cookies);
    const result = await f.request('/request-password-reset', { email, redirectTo: origin + '/redefinir-senha' });
    assert.ok(result.status < 300, result.raw);
    const resetMail = [...f.mails].reverse().find(mail => /\/reset-password\//.test(JSON.stringify(mail)));
    assert.ok(resetMail, 'The reset transport must receive a real token link');
    const token = JSON.stringify(resetMail).match(/\/reset-password\/([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token);
    const newPassword = 'Outra-senha-segura-de-teste-98!';
    const reset = await f.request('/reset-password', { token, newPassword });
    assert.ok(reset.status < 300, reset.raw);
    const replay = await f.request('/reset-password', { token, newPassword: password });
    assert.ok(replay.status >= 400 && replay.status < 500);
    f.cookies.clear();
    for (const [key, value] of oldCookies) f.cookies.set(key, value);
    assert.equal((await f.request('/get-session')).data, null);
    assert.ok((await f.request('/sign-in/email', { email, password })).status >= 400);
    assert.ok((await f.request('/sign-in/email', { email, password: newPassword })).status < 300);
  } finally { f.close(); }
});

test('missing email credentials fail before signup and disclose no fake delivery or secret', async () => {
  const f = fixture({ ...configuration, RESEND_API_KEY: undefined, EMAIL_FROM: undefined }, false);
  try {
    const signup = await f.request('/sign-up/email', { name: 'Não deve ser criada', email: 'missing@cafegestor.test', password });
    assert.equal(signup.status, 503);
    assert.equal(f.mails.length, 0);
    assert.equal(f.native.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n, 0);
    assert.equal(signup.raw.includes(configuration.BETTER_AUTH_SECRET), false);
    assert.equal(signup.raw.includes(password), false);
  } finally { f.close(); }
});

test('provider transport failure produces a sanitized error and leaves the account inactive', async () => {
  const providerDetail = 'Private provider response re_do_not_disclose_this_secret';
  const f = fixture(configuration, async () => { throw new Error(providerDetail); });
  try {
    const result = await f.request('/sign-up/email', { name: 'Sem entrega', email: 'failure@cafegestor.test', password });
    assert.equal(result.status, 503);
    assert.equal(result.raw.includes(providerDetail), false);
    assert.equal(result.raw.includes(configuration.RESEND_API_KEY), false);
    assert.equal(result.raw.includes(password), false);
    assert.equal((await f.request('/get-session')).data, null);
    const user = f.native.prepare('SELECT email_verified FROM auth_users WHERE email=?').get('failure@cafegestor.test');
    assert.equal(user?.email_verified || 0, 0);
  } finally { f.close(); }
});

test('expired password-reset links cannot change the password', async () => {
  const f = fixture();
  try {
    const { email } = await f.verifiedLogin();
    const result = await f.request('/request-password-reset', { email, redirectTo: origin + '/redefinir-senha' });
    assert.ok(result.status < 300, result.raw);
    const resetMail = [...f.mails].reverse().find(mail => /\/reset-password\//.test(JSON.stringify(mail)));
    const token = JSON.stringify(resetMail).match(/\/reset-password\/([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token);
    f.native.exec('UPDATE auth_verifications SET expires_at=0');
    const changed = await f.request('/reset-password', { token, newPassword: 'Nao-deve-ser-salva-42!' });
    assert.ok(changed.status >= 400 && changed.status < 500);
    assert.ok((await f.request('/sign-in/email', { email, password })).status < 300);
  } finally { f.close(); }
});

test('reset and a concurrent password login serialize the same account and cannot leave an old-password session alive', async () => {
  const f = fixture();
  let resume;
  let loginPromise;
  try {
    const { email } = await f.verifiedLogin();
    assert.ok((await f.request('/request-password-reset', { email, redirectTo: origin + '/redefinir-senha' })).status < 300);
    const resetMail = [...f.mails].reverse().find(mail => /\/reset-password\//.test(JSON.stringify(mail)));
    const token = JSON.stringify(resetMail).match(/\/reset-password\/([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token);
    assert.equal(JSON.stringify(f.native.prepare('SELECT identifier,value FROM auth_verifications').all()).includes(token), false, 'Reset link tokens must not be stored in plaintext');

    let reachedPasswordRead;
    const passwordRead = new Promise(resolve => { reachedPasswordRead = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    let interceptOnce = true;
    const originalPrepare = f.db.prepare.bind(f.db);
    function intercept(statement, sql) {
      return {
        bind(...values) { return intercept(statement.bind(...values), sql); },
        first(...args) { return statement.first(...args); },
        all(...args) { return statement.all(...args); },
        run(...args) { return statement.run(...args); },
        runSync(...args) { return statement.runSync(...args); },
        async raw(...args) {
          const rows = await statement.raw(...args);
          if (interceptOnce && /from\s+["`]?auth_accounts\b/i.test(sql)) {
            interceptOnce = false;
            reachedPasswordRead();
            await gate;
          }
          return rows;
        },
      };
    }
    f.db.prepare = sql => intercept(originalPrepare(sql), sql);
    loginPromise = f.request('/sign-in/email', { email, password });
    let timeout;
    await Promise.race([passwordRead, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('The login did not read its persisted password')), 3000); })]).finally(() => clearTimeout(timeout));
    const overlap = await f.request('/reset-password', { token, newPassword: 'Nova-senha-concorrente-42!' });
    assert.equal(overlap.status, 429, 'A reset must not run past the lock of a login already checking the old password');
    resume();
    assert.ok((await loginPromise).status < 300);
    const reset = await f.request('/reset-password', { token, newPassword: 'Nova-senha-concorrente-42!' });
    assert.ok(reset.status < 300, reset.raw);
    assert.equal((await f.request('/get-session')).data, null);
  } finally {
    resume?.();
    await loginPromise?.catch(() => {});
    f.close();
  }
});
