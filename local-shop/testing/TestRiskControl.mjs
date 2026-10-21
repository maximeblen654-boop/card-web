// Local fake-stock acceptance only. Does not charge money, contact suppliers, or acknowledge agreements.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { readMockConfig, callbackFields } from './MockPayment.mjs';

const root = new URL('../', import.meta.url);
const sessionFile = new URL('runtime/risk-session.json', root);
const reportFile = new URL('risk-checks.json', root);
const policy = JSON.parse(readFileSync(new URL('risk-policy.json', root), 'utf8'));
const origin = 'http://127.0.0.1:18080';
const databaseFile = new URL('runtime/db/dujiao.db', root);
const sqlitePath = decodeURIComponent(databaseFile.pathname).replace(/^\/(\w:)/, '$1');
const yaml = readFileSync(new URL('runtime/config.yml', root), 'utf8');
assert.match(yaml, /server:\s*\n  host: 127\.0\.0\.1\s*\n  port: 18080/);
assert.match(yaml, /trusted_proxies: \[\]/);
assert.match(yaml, /email:\s*\n  enabled: false/);
let state = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : null;
let report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : {
  scope: 'local non-paid tests with synthetic stock only', checks: [], result: 'IN_PROGRESS', real_payments: 0,
};
const save = () => {
  if (state) writeFileSync(sessionFile, JSON.stringify(state, null, 2) + '\n');
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
};
const check = (name, evidence = {}) => { report.checks.push({ name, result: 'PASS', ...evidence }); save(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function raw(path, { body, headers = {}, method, timeout = 15000 } = {}) {
  const response = await fetch(origin + path, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Accept-Language': 'zh-CN', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeout) });
  const value = await response.json();
  return { ...value, http_status: response.status, retry_after: response.headers.get('retry-after') };
}
const ok = value => [0, 200].includes(value.status_code);
async function api(path, options) {
  const result = await raw(path, options);
  assert.ok(ok(result), `Local API refused ${path.split('?')[0]}: ${result.msg}`);
  return result.data;
}
const admin = () => ({ Authorization: `Bearer ${state.admin_token}` });
const member = user => ({ Authorization: `Bearer ${user.token}` });
function readDB(sql, ...parameters) {
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try { return db.prepare(sql).all(...parameters); } finally { db.close(); }
}
const stock = () => api(`/api/v1/admin/card-secrets/stats?product_id=${state.product_id}&sku_id=${state.sku_id}`, { headers: admin() });
function trialPolicy() {
  const value = structuredClone(policy);
  value.guest.payment_expire_minutes = 1;
  for (const role of ['guest', 'member']) value[role].rate_limit = { enabled: true, window_seconds: 10, max_requests: 3, block_seconds: 10 };
  return value;
}
async function setPolicy(value) {
  const saved = await api('/api/v1/admin/settings', { method: 'PUT', headers: admin(), body: { key: 'order_risk_control_config', value } });
  assert.deepEqual(saved, value);
}
async function resetTestRates() {
  const config = readFileSync(new URL('runtime/redis/redis.conf', root), 'utf8');
  const secret = config.match(/^requirepass ([a-f0-9]+)$/m)?.[1];
  assert.ok(secret);
  const keys = ['dj:risk:order_rate:guest_ip:127.0.0.1', ...state.members.map(user => `dj:risk:order_rate:user:${user.id}`)];
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 16379 });
    let reply = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Local Redis timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`AUTH ${secret}\r\nSELECT 0\r\nDEL ${keys.join(' ')}\r\n`));
    socket.on('data', chunk => {
      reply += chunk.toString('utf8');
      if (reply.startsWith('-') || reply.length > 4096) socket.destroy(new Error('Local Redis command refused'));
      if (/^\+OK\r\n\+OK\r\n:\d+\r\n/.test(reply)) { socket.end(); resolve(); }
    });
  });
}
async function createGuest(label, { items, headers = {}, timeout } = {}) {
  const intent = { label, email: `risk-${randomBytes(5).toString('hex')}@shop.invalid`, password: `Aa9-${randomBytes(12).toString('hex')}` };
  state.guests.push(intent); save();
  const result = await raw('/api/v1/guest/orders', { headers, timeout, body: { email: intent.email,
    order_password: intent.password, items: items || [{ product_id: state.product_id, sku_id: state.sku_id, quantity: 1 }] } });
  intent.status_code = result.status_code;
  intent.order_no = result.data?.order_no;
  intent.expires_at = result.data?.expires_at;
  save();
  return { intent, result };
}
async function createMember(user, items) {
  return raw('/api/v1/orders', { headers: member(user), body: { items: items || [{ product_id: state.product_id, sku_id: state.sku_id, quantity: 1 }] } });
}
async function cancelMember(user, orderNo) {
  const canceled = await api(`/api/v1/orders/${encodeURIComponent(orderNo)}/cancel`, { headers: member(user), body: {} });
  assert.equal(canceled.status, 'canceled');
}
async function waitBackgroundExpiry(orderNos, label) {
  console.log(`Waiting for background expiry: ${label}`);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const rows = readDB(`SELECT order_no,status,expires_at FROM orders WHERE order_no IN (${orderNos.map(() => '?').join(',')})`, ...orderNos);
    if (rows.length === orderNos.length && rows.every(row => row.status === 'canceled')) {
      check(label, { orders: orderNos.length, observed_by_raw_database_without_order_read: true });
      return;
    }
    await wait(500);
  }
  throw new Error(`Background expiry did not complete: ${label}`);
}

async function setup() {
  assert.equal(state, null, 'Existing risk test session retained; inspect before creating more test data');
  const password = yaml.match(/^  default_admin_password: "([^"]+)"/m)?.[1];
  const login = await api('/api/v1/admin/login', { body: { username: 'local-owner', password } });
  state = { admin_token: login.token, members: [], guests: [], started_at: new Date().toISOString() }; save();
  state.original_policy = await api('/api/v1/admin/settings?key=order_risk_control_config', { headers: admin() }); save();
  const created = await api('/api/v1/admin/products', { headers: admin(), body: {
    category_id: 1, slug: `local-risk-test-${Date.now()}`, title: { 'zh-CN': '防刷验收专用 · 无效测试卡', 'en-US': 'Risk test fixture only' },
    description: { 'zh-CN': '仅供本机风控验收，没有充值价值。' }, price_amount: 1, fulfillment_type: 'auto', purchase_type: 'guest',
    is_active: true, max_purchase_quantity: 0, min_purchase_quantity: 1, stock_display_mode: 'exact', tags: ['风控验收专用'], payment_channel_ids: [1],
  } });
  state.product_id = created.id;
  const product = await api(`/api/v1/admin/products/${created.id}`, { headers: admin() });
  state.sku_id = product.skus[0].id; save();
  const batch = await api('/api/v1/admin/card-secrets/batch', { headers: admin(), body: { product_id: state.product_id,
    sku_id: state.sku_id, secrets: Array.from({ length: 16 }, (_, i) => `RISK-TEST-NO-VALUE-${String(i + 1).padStart(3, '0')}`),
    batch_no: `RISK-${Date.now()}`, note: 'Synthetic local abuse-test stock only', deduplicate: true } });
  assert.equal(batch.created, 16);
  const publicConfig = await api('/api/v1/public/config');
  assert.equal(publicConfig.email_verification_enabled, true);
  // Test-only email challenges for two .invalid addresses. Real email delivery is not being tested.
  // Registration still runs the unmodified code verification and password policy checks.
  for (let index = 0; index < 2; index++) {
    const email = `risk-member-${randomBytes(5).toString('hex')}@shop.invalid`;
    const userPassword = `Aa9-${randomBytes(14).toString('hex')}`;
    const code = String(randomInt(100000, 1000000));
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const date = value => value.toISOString().replace('T', ' ').replace('Z', '+00:00');
      const now = new Date();
      db.prepare('INSERT INTO email_verify_codes (email,purpose,code,expires_at,attempt_count,sent_at,created_at) VALUES (?,?,?,?,0,?,?)')
        .run(email, 'register', code, date(new Date(Date.now() + 300000)), date(now), date(now));
    } finally { db.close(); }
    const account = await api('/api/v1/auth/register', { body: { email, password: userPassword, code, agreement_accepted: true } });
    state.members.push({ id: account.user.id, email, password: userPassword, token: account.token }); save();
  }
  const disabled = trialPolicy(); disabled.enabled = false;
  await setPolicy(disabled);
  state.setup_complete = true; save();
  console.log('Prepared isolated 16-card fixture and two synthetic member accounts; email verification remains enabled.');
}

async function baseline() {
  assert.ok(state?.setup_complete && !state.baseline_orders);
  const attempts = await Promise.all(Array.from({ length: 3 }, (_, i) => createGuest(`baseline-${i}`)));
  assert.ok(attempts.every(attempt => ok(attempt.result)), 'Baseline requests must reach the order service');
  state.baseline_orders = attempts.map(attempt => attempt.intent.order_no); save();
  const current = await stock();
  assert.equal(current.reserved, 3); assert.equal(current.used, 0);
  report.before_controls = { attempted: 3, accepted: 3, reserved: current.reserved, same_actual_source: '127.0.0.1' };
  await setPolicy(trialPolicy());
  check('Control-off baseline reproduced three rotating-email reservations', report.before_controls);
  console.log('Baseline reproduced; controls are now enabled.');
}

async function verify() {
  assert.ok(state?.baseline_orders && !state.verify_complete);
  await waitBackgroundExpiry(state.baseline_orders, 'Expired baseline orders release through the background worker');
  assert.deepEqual(await stock(), { total: 16, available: 16, reserved: 0, used: 0 });
  await resetTestRates();
  const over = await createGuest('over-quantity', { items: [{ product_id: state.product_id, sku_id: state.sku_id, quantity: 2 }] });
  assert.ok(!ok(over.result)); assert.equal((await stock()).reserved, 0);
  const split = await createGuest('split-quantity', { items: [{ product_id: state.product_id, sku_id: state.sku_id, quantity: 1 },
    { product_id: state.product_id, sku_id: state.sku_id, quantity: 1 }] });
  assert.ok(!ok(split.result)); assert.equal((await stock()).reserved, 0);
  check('Per-product quantity limit rejects both one large item and split duplicate items');
  const attempts = await Promise.all(Array.from({ length: 6 }, (_, i) => createGuest(`rotating-email-${i}`, { headers: {
    'X-Forwarded-For': `198.18.0.${i + 1}`, 'X-Real-IP': `198.18.1.${i + 1}`, 'CF-Connecting-IP': `198.18.2.${i + 1}`,
  } })));
  const accepted = attempts.filter(attempt => ok(attempt.result));
  assert.equal(accepted.length, 1);
  state.capped_guest_order = accepted[0].intent.order_no; save();
  const row = readDB('SELECT risk_ip FROM orders WHERE order_no=?', state.capped_guest_order)[0];
  assert.equal(row.risk_ip, '127.0.0.1');
  assert.equal((await stock()).reserved, 1);
  check('Six concurrent rotating-email and forged-forwarding requests reserve only one card', {
    attempted: 6, accepted: 1, denied: 5, stored_source: row.risk_ip,
  });
  let isolated = trialPolicy(); isolated.guest.max_pending_orders_per_ip = 0; isolated.guest.rate_limit.enabled = false;
  await setPolicy(isolated);
  const quota = await createGuest('pending-product-quota');
  assert.ok(!ok(quota.result)); assert.equal((await stock()).reserved, 1);
  check('Per-IP product reservation quota holds independently of the pending-order count limit');
  await setPolicy(trialPolicy()); await resetTestRates();
  const [first, second] = state.members;
  const firstOrder = await createMember(first); assert.ok(ok(firstOrder));
  state.member_order = firstOrder.data.order_no; save();
  isolated = trialPolicy(); isolated.member.max_pending_orders_per_ip = 0; isolated.member.rate_limit.enabled = false;
  await setPolicy(isolated);
  assert.ok(!ok(await createMember(first)));
  check('A member cannot open a second pending order even with the IP count check isolated out');
  isolated.member.max_pending_orders_per_user = 0; isolated.member.max_pending_orders_per_ip = 1;
  await setPolicy(isolated);
  assert.ok(!ok(await createMember(second)));
  check('Changing member accounts at the same source cannot bypass the member IP cap');
  report.separate_role_budget = { guest_reserved: 1, member_reserved: 1, total_same_ip: (await stock()).reserved };
  assert.equal(report.separate_role_budget.total_same_ip, 2);
  await cancelMember(first, state.member_order);
  assert.equal((await stock()).reserved, 1);
  check('Canceling an unpaid member order releases its card immediately');
  await setPolicy(trialPolicy()); await resetTestRates();
  const absentProduct = [{ product_id: 2147483000, quantity: 1 }];
  const guestRates = [];
  for (let i = 0; i < 4; i++) guestRates.push((await createGuest(`guest-rate-${i}`, { items: absentProduct })).result);
  assert.ok(guestRates.slice(0, 3).every(result => result.status_code !== 429 && !ok(result)));
  assert.equal(guestRates[3].status_code, 429); assert.ok(Number(guestRates[3].retry_after) > 0);
  const memberRates = [];
  for (let i = 0; i < 4; i++) memberRates.push(await createMember(first, absentProduct));
  assert.ok(memberRates.slice(0, 3).every(result => result.status_code !== 429 && !ok(result)));
  assert.equal(memberRates[3].status_code, 429); assert.ok(Number(memberRates[3].retry_after) > 0);
  check('Guest and member fourth attempts are rate-limited with Retry-After', {
    guest_retry_after: Number(guestRates[3].retry_after), member_retry_after: Number(memberRates[3].retry_after),
  });
  await wait(1100);
  const blockedAgain = await createGuest('guest-block-still-active', { items: absentProduct });
  assert.equal(blockedAgain.result.status_code, 429);
  check('Rate block remains active during its configured interval');
  await wait(10500);
  const afterBlock = await createGuest('guest-block-expired', { items: absentProduct });
  assert.notEqual(afterBlock.result.status_code, 429); assert.ok(!ok(afterBlock.result));
  check('Rate block naturally expires without an administrator reset');
  isolated = trialPolicy(); isolated.common.ip_blacklist = ['127.0.0.1'];
  await setPolicy(isolated);
  const blacklistedGuest = await createGuest('blacklist-guest');
  const blacklistedMember = await createMember(second);
  assert.ok(!ok(blacklistedGuest.result) && !ok(blacklistedMember));
  check('Configured source blacklist blocks both guest and member order creation');
  await setPolicy(trialPolicy());
  await waitBackgroundExpiry([state.capped_guest_order], 'Capped unpaid order expires and frees its reservation automatically');
  assert.deepEqual(await stock(), { total: 16, available: 16, reserved: 0, used: 0 });
  state.verify_complete = true; save();
  console.log('Risk checks passed; all temporary unpaid reservations have been released.');
}

async function fault() {
  assert.ok(state?.verify_complete && !state.fault_attempt);
  state.fault_attempt = true; save();
  const attempt = await createGuest('redis-outage', { timeout: 45000 });
  assert.ok(!ok(attempt.result), 'An order must not be accepted without the timeout task service');
  const rows = readDB('SELECT order_no,status FROM orders WHERE guest_email=? AND parent_id IS NULL', attempt.intent.email);
  assert.ok(rows.every(row => row.status === 'canceled'));
  const reserved = readDB("SELECT COUNT(*) AS count FROM card_secrets WHERE product_id=? AND status='reserved'", state.product_id)[0].count;
  assert.equal(reserved, 0);
  report.redis_outage = { status_code: attempt.result.status_code, created_parent_rows: rows.length,
    final_statuses: rows.map(row => row.status), reserved_cards: reserved };
  check('Redis outage refuses checkout and compensates any temporary inventory reservation', report.redis_outage);
  state.fault_complete = true; save();
  console.log('Redis outage check passed; no card remains reserved.');
}

async function finalize() {
  assert.ok(state?.verify_complete && state.fault_complete);
  assert.match(yaml, /order:\s*\n  payment_expire_minutes: 5\b/);
  await setPolicy(policy); await resetTestRates();
  const quantityAttempt = await createMember(state.members[0], [{ product_id: state.product_id, sku_id: state.sku_id, quantity: 2 }]);
  assert.ok(!ok(quantityAttempt)); assert.equal((await stock()).reserved, 0);
  check('Final member per-product purchase limit rejects an oversized purchase without reserving stock');
  const ordinary = await createMember(state.members[0]);
  assert.ok(ok(ordinary));
  assert.equal(new Date(ordinary.data.expires_at) - new Date(ordinary.data.created_at), 300000);
  await cancelMember(state.members[0], ordinary.data.order_no);
  check('Normal member checkout still succeeds with a five-minute deadline and releases stock on cancellation');
  for (const account of state.members) {
    await api(`/api/v1/admin/users/${account.id}`, { method: 'PUT', headers: admin(), body: { status: 'disabled', admin_note: 'Completed local risk-test fixture; never a customer account' } });
  }
  await api(`/api/v1/admin/products/${state.product_id}`, { method: 'PATCH', headers: admin(), body: { is_active: false } });
  assert.deepEqual(await stock(), { total: 16, available: 16, reserved: 0, used: 0 });
  const original = JSON.parse(readFileSync(new URL('runtime/checkout-session.json', root), 'utf8'));
  const gateway = readMockConfig();
  const fields = callbackFields(Object.fromEntries(new URL(original.pay_url).searchParams), gateway);
  const callback = await fetch(origin + '/api/v1/payments/callback', { method: 'POST', body: new URLSearchParams(fields),
    redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal((await callback.text()).trim(), 'success');
  const originalOrder = readDB('SELECT status FROM orders WHERE order_no=?', original.order_no)[0];
  assert.equal(originalOrder.status, 'completed');
  const demoStock = await api('/api/v1/admin/card-secrets/stats?product_id=1&sku_id=1', { headers: admin() });
  assert.deepEqual(demoStock, { total: 3, available: 2, reserved: 0, used: 1 });
  check('Final controls preserve the previous paid order and accept its valid callback without duplicate delivery');
  report.result = 'PASS'; report.checked_at = new Date().toISOString(); report.final_policy = policy;
  report.temporary_test_policy = trialPolicy();
  report.expiry_test_scope = { real_background_timeout_observed_minutes: 1, final_guest_minutes: 5,
    final_member_minutes_verified_on_created_order: 5, final_five_minute_background_wait_not_repeated: true };
  report.fixture_cleanup = { product_hidden: true, synthetic_members_disabled: true, pending_reservations: 0 };
  report.remaining = ['Guest and member IP budgets are separate: one source can hold one of each',
    'Many distinct real sources can still reserve stock; production edge protection and supplier strategy remain pending',
    'Redis limiter itself allows script errors; the tested full outage is protected by order timeout-task compensation'];
  state.complete = true; save();
  console.log(JSON.stringify({ result: report.result, passed_checks: report.checks.length, real_payments: 0,
    temporary_reservations_remaining: 0, final_expire_minutes: policy.guest.payment_expire_minutes }));
}

const actions = { setup, baseline, verify, fault, finalize };
const action = actions[process.argv[2]];
if (!action) throw new Error('Choose setup, baseline, verify, fault, or finalize');
action().catch(error => { report.result = 'NEEDS_INSPECTION'; report.last_error = error.message; save(); console.error(error.message); process.exitCode = 1; });
