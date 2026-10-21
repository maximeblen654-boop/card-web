// Local-only hardening and rejection checks; never solves a CAPTCHA or contacts a real gateway.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readMockConfig, callbackFields } from './MockPayment.mjs';

const root = new URL('../', import.meta.url);
const risk = JSON.parse(readFileSync(new URL('runtime/risk-session.json', root), 'utf8'));
const checkout = JSON.parse(readFileSync(new URL('runtime/checkout-session.json', root), 'utf8'));
const headers = { Authorization: `Bearer ${risk.admin_token}` };
const origin = 'http://127.0.0.1:18080';
const dbPath = decodeURIComponent(new URL('runtime/db/dujiao.db', root).pathname).replace(/^\/(\w:)/, '$1');
const reportPath = new URL('protection-checks.json', root);
const report = { scope: 'local official binary, synthetic requests only', result: 'IN_PROGRESS', checks: [],
  real_payments: 0, supplier_requests: 0, captcha_solved_by_agent: false, valid_new_guest_checkout_tested: false };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const check = (name, evidence = {}) => { report.checks.push({ name, result: 'PASS', ...evidence }); save(); };
async function raw(path, { body, auth = {}, method } = {}) {
  const response = await fetch(origin + path, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Accept-Language': 'en-US', ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10000) });
  return response.json();
}
async function api(path, options) {
  const value = await raw(path, options);
  assert.ok([0, 200].includes(value.status_code), `Local API refused ${path.split('?')[0]} (${value.status_code})`);
  return value.data;
}
const admin = (path, options = {}) => api('/api/v1/admin' + path, { ...options, auth: headers });
function snapshot() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return {
    orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
    stock: db.prepare('SELECT status, COUNT(*) AS n FROM card_secrets GROUP BY status ORDER BY status').all(),
  }; } finally { db.close(); }
}
function rejectCaptcha(value) {
  assert.equal(value.status_code, 400);
  assert.match(value.msg, /captcha/i);
  assert.ok(!value.data?.order_no);
}
const guestBody = { email: `protection-${randomBytes(6).toString('hex')}@shop.invalid`,
  order_password: `Aa9-${randomBytes(16).toString('hex')}`, items: [{ product_id: 2147483000, quantity: 1 }] };
const endpoints = ['/api/v1/guest/orders', '/api/v1/guest/orders/create-and-pay'];

async function run() {
  const yaml = readFileSync(new URL('runtime/config.yml', root), 'utf8');
  assert.match(yaml, /server:\s*\n  host: 127\.0\.0\.1\s*\n  port: 18080/);
  assert.match(yaml, /trusted_proxies: \[\]/);
  assert.match(yaml, /email:\s*\n  enabled: false/);
  assert.match(yaml, /order:\s*\n  payment_expire_minutes: 25\b/);
  const before = snapshot();
  const current = await admin('/settings/captcha');
  assert.equal(current.turnstile.has_secret, false, 'Do not replace an existing real Turnstile connection');
  const backupDir = new URL(`runtime/backups/before-captcha-${Date.now()}/`, root);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(new URL('runtime/config.yml', root), new URL('config.yml', backupDir));
  writeFileSync(new URL('captcha-setting.json', backupDir), JSON.stringify(current, null, 2));
  const backupDB = new DatabaseSync(dbPath);
  try { backupDB.prepare('VACUUM INTO ?').run(decodeURIComponent(new URL('dujiao.db', backupDir).pathname).replace(/^\/(\w:)/, '$1')); }
  finally { backupDB.close(); }
  report.backup_directory = decodeURIComponent(backupDir.pathname).replace(/^\/(\w:)/, '$1');
  if (current.provider === 'none') {
    for (const path of endpoints) {
      const value = await raw(path, { body: guestBody });
      assert.ok(![0, 200].includes(value.status_code));
      assert.doesNotMatch(value.msg, /captcha/i);
    }
    check('Disabled-CAPTCHA baseline reaches product validation without creating orders');
  }
  const setting = {
    provider: 'image', scenes: { login: true, register_send_code: true, reset_send_code: true,
      guest_create_order: true, gift_card_redeem: true },
    image: { length: 5, width: 240, height: 80, noise_count: 2, show_line: 2, expire_seconds: 300, max_store: 10240 },
  };
  const saved = await admin('/settings/captcha', { method: 'PUT', body: setting });
  assert.equal(saved.provider, 'image'); assert.deepEqual(saved.scenes, setting.scenes);
  check('Image verification is enabled on login, registration code, password reset, guest order and gift-card redeem');
  let published;
  for (let attempt = 0; attempt < 35; attempt++) {
    published = await api('/api/v1/public/config');
    if (published.captcha.provider === 'image') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(published.captcha.provider, 'image'); assert.deepEqual(published.captcha.scenes, setting.scenes);
  assert.equal(published.email_verification_enabled, true);
  check('Public configuration advertises verification while existing email-verification policy stays enabled');
  for (const path of endpoints) rejectCaptcha(await raw(path, { body: guestBody }));
  check('Both guest create and combined create-and-pay reject missing CAPTCHA at the server');
  for (const path of endpoints) rejectCaptcha(await raw(path, { body: { ...guestBody,
    captcha_payload: { captcha_id: 'not-a-generated-challenge', captcha_code: '!!!!!' } } }));
  check('Both guest order routes reject fabricated verification even when called directly');
  const challenge = await api('/api/v1/public/captcha/image');
  assert.ok(challenge.captcha_id && /^data:image\/png;base64,/.test(challenge.image_base64));
  assert.deepEqual(Object.keys(challenge).sort(), ['captcha_id', 'image_base64']);
  check('Challenge endpoint generates a PNG and does not disclose the answer');
  rejectCaptcha(await raw(endpoints[0], { body: { ...guestBody,
    captcha_payload: { captcha_id: challenge.captcha_id, captcha_code: '!!!!!' } } }));
  rejectCaptcha(await raw(endpoints[1], { body: { ...guestBody,
    captcha_payload: { captcha_id: challenge.captcha_id, captcha_code: '!!!!!' } } }));
  check('A real challenge with an impossible answer is refused; retrying it never creates an order');
  rejectCaptcha(await raw('/api/v1/auth/login', { body: { email: guestBody.email, password: guestBody.order_password } }));
  rejectCaptcha(await raw('/api/v1/admin/login', { body: { username: 'local-owner', password: 'not-the-local-password' } }));
  check('Customer and administrator login reject a missing verification before password attempts');
  const guestAuth = { Authorization: `Guest ${Buffer.from(checkout.email + '\n' + checkout.password).toString('base64url')}` };
  const order = await api(`/api/v1/guest/orders/${encodeURIComponent(checkout.order_no)}`, { auth: guestAuth });
  assert.equal(order.status, 'completed');
  const payloads = value => [value.fulfillment?.payload || '', ...(value.children || []).flatMap(payloads)];
  assert.equal(payloads(order).filter(Boolean).length, 1);
  assert.match(payloads(order).find(Boolean), /^DEMO-NO-VALUE-\d{3}$/);
  check('A legitimate previous customer can still retrieve their delivered card without a new CAPTCHA');
  const gateway = readMockConfig();
  const fields = callbackFields(Object.fromEntries(new URL(checkout.pay_url).searchParams), gateway);
  const response = await fetch(origin + '/api/v1/payments/callback', { method: 'POST', body: new URLSearchParams(fields),
    redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal((await response.text()).trim(), 'success');
  check('A signed local payment notification remains machine-readable and is not sent to CAPTCHA');
  const riskSetting = await admin('/settings?key=order_risk_control_config');
  assert.deepEqual(riskSetting, JSON.parse(readFileSync(new URL('risk-policy.json', root), 'utf8')));
  assert.equal(riskSetting.guest.payment_expire_minutes, 25);
  assert.deepEqual(snapshot(), before);
  check('Existing limits and 25-minute deadline remain saved; all order counts and stock counts stay unchanged');
  report.result = 'PASS'; report.checked_at = new Date().toISOString(); report.setting = setting;
  report.source_sha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  report.pending = ['Human completion of a fresh guest CAPTCHA and new checkout',
    'Production Cloudflare/Turnstile, origin isolation and trusted proxy chain',
    'Distributed reservation abuse and Redis limiter script-error behavior'];
  save(); console.log(JSON.stringify({ result: report.result, checks: report.checks.length, provider: saved.provider,
    orders_created: snapshot().orders - before.orders, real_payments: 0, deadline_minutes: 25 }));
}
run().catch(error => { report.result = 'NEEDS_INSPECTION'; report.error = error.message; save(); console.error(error.message); process.exitCode = 1; });
