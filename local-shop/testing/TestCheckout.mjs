// Non-paid acceptance against the local Dujiao-Next binary. Never acknowledges agreements.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readMockConfig, sign, callbackFields } from './MockPayment.mjs';

const root = new URL('../', import.meta.url);
const sessionPath = new URL('runtime/checkout-session.json', root);
const reportPath = new URL('checkout-checks.json', root);
const config = readMockConfig();
const origin = config.shop_origin;
const checks = [];
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function response(path, { body, headers = {}, ...options } = {}) {
  return fetch(origin + path, { ...options, headers: { 'Accept-Language': 'zh-CN', ...headers,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body), method: 'POST' }),
    redirect: 'error', signal: AbortSignal.timeout(10000) });
}

async function api(path, options) {
  const res = await response(path, options);
  const value = await res.json();
  if (!res.ok || ![0, 200].includes(value.status_code)) {
    throw new Error(`Local API refused ${path.split('?')[0]}: ${value.msg || res.status}`);
  }
  return value.data;
}

function guestHeaders(email, password) {
  return { Authorization: `Guest ${Buffer.from(`${email}\n${password}`).toString('base64url')}` };
}

function payloads(order) {
  return [order.fulfillment?.payload || '', ...(order.children || []).flatMap(payloads)];
}

function record(name) { checks.push({ name, result: 'PASS' }); }

async function run() {
  assert.ok(config.channel_id, 'The local simulated channel must already exist');
  const yaml = readFileSync(new URL('runtime/config.yml', root), 'utf8');
  assert.match(yaml, /server:\s*\n  host: 127\.0\.0\.1\s*\n  port: 18080/);
  assert.match(yaml, /email:\s*\n  enabled: false/);
  const adminPassword = yaml.match(/^  default_admin_password: "([^"]+)"/m)?.[1];
  assert.ok(adminPassword, 'Missing local administrator configuration');
  const login = await api('/api/v1/admin/login', { body: { username: 'local-owner', password: adminPassword } });
  const adminHeaders = { Authorization: `Bearer ${login.token}` };
  const compliance = await api('/api/v1/admin/compliance/status', { headers: adminHeaders });
  assert.equal(compliance.acknowledged, true, 'Operator must personally authorize the statement first');
  if (existsSync(sessionPath)) {
    const previous = JSON.parse(readFileSync(sessionPath, 'utf8'));
    if (previous.complete && existsSync(reportPath)) {
      const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
      const persisted = await api(`/api/v1/guest/orders/${encodeURIComponent(previous.order_no)}`, {
        headers: guestHeaders(previous.email, previous.password),
      });
      assert.equal(persisted.status, saved.order_status);
      assert.equal(payloads(persisted).filter(Boolean).length, 1);
      assert.match(payloads(persisted).find(Boolean), /^DEMO-NO-VALUE-\d{3}$/);
      const currentStock = await api(`/api/v1/admin/card-secrets/stats?product_id=1&sku_id=${previous.sku_id}`, { headers: adminHeaders });
      assert.deepEqual(currentStock, saved.stock_after);
      saved.restart_persistence = 'PASS';
      save(reportPath, saved);
      console.log('PASS: saved order and single-card delivery retained after restart; no new order created.');
      return;
    }
    throw new Error('A previous test session needs inspection; refusing to create a duplicate order');
  }
  const product = await api('/api/v1/admin/products/1', { headers: adminHeaders });
  assert.equal(product.slug, 'local-demo-card');
  assert.equal(product.fulfillment_type, 'auto');
  const sku = product.skus.find(item => item.is_active);
  assert.ok(sku);
  const stockPath = `/api/v1/admin/card-secrets/stats?product_id=1&sku_id=${sku.id}`;
  const stock = () => api(stockPath, { headers: adminHeaders });
  const before = await stock();
  assert.ok(before.available >= 1, 'Need one synthetic card');
  const session = { email: `demo-${randomBytes(5).toString('hex')}@shop.invalid`,
    password: `Aa9-${randomBytes(12).toString('hex')}`, product_id: 1, sku_id: sku.id,
    created_at: new Date().toISOString(), create_intent_saved: true, complete: false };
  save(sessionPath, session);
  const auth = guestHeaders(session.email, session.password);
  const created = await api('/api/v1/guest/orders', { body: { email: session.email,
    order_password: session.password, items: [{ product_id: 1, sku_id: sku.id, quantity: 1 }] } });
  session.order_no = created.order_no;
  assert.ok(session.order_no);
  session.order_url = `${origin}/guest/orders/${encodeURIComponent(session.order_no)}`;
  save(sessionPath, session);
  const orderPath = `/api/v1/guest/orders/${encodeURIComponent(session.order_no)}`;
  const detail = () => api(orderPath, { headers: auth });
  const assertUnpaid = async () => {
    const order = await detail();
    assert.equal(order.status, 'pending_payment');
    assert.ok(!JSON.stringify(order).includes('DEMO-NO-VALUE-'));
    assert.equal((await stock()).used, before.used);
  };
  await assertUnpaid();
  const pendingStock = await stock();
  record('Unpaid order does not reveal or use a card');
  async function assertDenied(headers, path = orderPath) {
    const res = await response(path, { headers });
    const text = await res.text();
    assert.ok(!text.includes('DEMO-NO-VALUE-'));
    const value = JSON.parse(text);
    assert.ok(value.status_code >= 400, 'Unauthorized request must be refused');
  }
  await assertDenied({});
  await assertDenied(guestHeaders(session.email, session.password + '-wrong'));
  await assertDenied(guestHeaders('another@shop.invalid', session.password));
  record('Missing credentials, wrong password, and another email cannot access the order');
  const paymentResult = await api('/api/v1/guest/payments', {
    headers: auth, body: { order_no: session.order_no, channel_id: config.channel_id } });
  assert.ok(paymentResult.pay_url, 'Missing standard gateway redirect');
  const payUrl = new URL(paymentResult.pay_url);
  assert.equal(payUrl.origin, 'http://127.0.0.1:18081');
  const payment = Object.fromEntries(payUrl.searchParams);
  assert.ok(payment.out_trade_no);
  session.pay_url = payUrl.href;
  save(sessionPath, session);
  const fields = callbackFields(payment, config);
  const callback = async form => {
    const res = await fetch(`${origin}/api/v1/payments/callback`, { method: 'POST',
      body: new URLSearchParams(form), redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 200);
    return (await res.text()).trim();
  };
  assert.equal(await callback({ ...fields, sign: '0'.repeat(32) }), 'fail');
  await assertUnpaid();
  record('Invalid callback signature cannot pay or deliver');
  const wrongAmount = { ...fields, money: (Number(fields.money) + 1).toFixed(2) };
  wrongAmount.sign = sign(wrongAmount, config.merchant_key);
  assert.equal(await callback(wrongAmount), 'fail');
  await assertUnpaid();
  record('Correctly signed callback with wrong amount is rejected');
  const wrongMerchant = { ...fields, pid: String(Number(config.merchant_id) + 1) };
  wrongMerchant.sign = sign(wrongMerchant, config.merchant_key);
  assert.equal(await callback(wrongMerchant), 'fail');
  await assertUnpaid();
  record('Correctly signed callback for another merchant is rejected');
  const gatewayPage = await fetch(payUrl, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(gatewayPage.status, 200);
  const gatewayHtml = await gatewayPage.text();
  const token = gatewayHtml.match(/name="token" value="([a-f0-9]+)"/)?.[1];
  assert.ok(token, 'Simulated checkout must accept the app-generated signed request');
  const started = performance.now();
  const confirm = await fetch('http://127.0.0.1:18081/confirm', { method: 'POST',
    body: new URLSearchParams({ token }), redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(confirm.status, 303, 'Simulated checkout must receive callback success');
  let paid;
  for (let attempt = 0; attempt < 60; attempt++) {
    paid = await detail();
    if (['delivered', 'completed'].includes(paid.status) && payloads(paid).some(Boolean)) break;
    await wait(100);
  }
  const deliveryMs = Math.round(performance.now() - started);
  assert.ok(['delivered', 'completed'].includes(paid.status), 'Worker must automatically deliver');
  const cards = payloads(paid).flatMap(value => value.split(/\r?\n/)).map(value => value.trim()).filter(Boolean);
  assert.equal(cards.length, 1);
  assert.match(cards[0], /^DEMO-NO-VALUE-\d{3}$/);
  const delivered = await stock();
  assert.equal(delivered.used, before.used + 1);
  assert.equal(delivered.available, before.available - 1);
  assert.equal(delivered.reserved, before.reserved);
  record('Standard signed payment notification triggers automatic single-card delivery without email');
  const repeats = await Promise.all(Array.from({ length: 4 }, () => callback(fields)));
  assert.deepEqual(repeats, ['success', 'success', 'success', 'success']);
  const after = await stock();
  assert.deepEqual(after, delivered);
  assert.deepEqual(payloads(await detail()), payloads(paid));
  record('Four concurrent repeated callbacks do not issue another card');
  await assertDenied(guestHeaders(session.email, session.password + '-wrong'));
  await assertDenied(guestHeaders(session.email, session.password + '-wrong'), orderPath + '/fulfillment/download');
  const download = await response(orderPath + '/fulfillment/download', { headers: auth });
  assert.equal(download.status, 200);
  const downloaded = await download.text();
  assert.equal(downloaded.split(cards[0]).length - 1, 1);
  record('Paid order and card download require the correct guest credentials');
  const report = { checked_at: new Date().toISOString(), scope: 'local simulation only; zero real payments or upstream calls',
    result: 'PASS', order_no: session.order_no, order_url: session.order_url, order_status: paid.status,
    delivery_ms_local_sample: deliveryMs, email_enabled: false, standard_callback_signature_retained: true,
    stock_before: before, stock_while_unpaid: pendingStock, stock_after: after, checks,
    remaining: ['Browser verification pending', 'Production payment and supplier not connected',
      'Native prepaid stock is still reserved by unpaid orders; anti-abuse acceptance remains pending'] };
  save(reportPath, report);
  session.complete = true;
  save(sessionPath, session);
  console.log(JSON.stringify({ result: report.result, order_no: session.order_no, order_status: paid.status,
    local_delivery_ms: deliveryMs, passed_checks: checks.length, real_payments: 0, upstream_requests: 0 }));
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
