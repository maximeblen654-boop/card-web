// Targeted local deadline check. Uses existing synthetic fixtures and cancels its own unpaid order.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const state = JSON.parse(readFileSync(new URL('runtime/risk-session.json', root), 'utf8'));
const policy = JSON.parse(readFileSync(new URL('risk-policy.json', root), 'utf8'));
const yaml = readFileSync(new URL('runtime/config.yml', root), 'utf8');
const minutes = Number(yaml.match(/^order:\s*\n  payment_expire_minutes: (\d+)\b/m)?.[1]);
assert.equal(minutes, policy.guest.payment_expire_minutes);
assert.ok(minutes > 0);
assert.match(yaml, /server:\s*\n  host: 127\.0\.0\.1\s*\n  port: 18080/);
assert.match(yaml, /email:\s*\n  enabled: false/);
assert.ok(state.complete, 'Finish the existing isolated risk acceptance first');
const account = state.members[0];
assert.ok(account.email.endsWith('@shop.invalid'));
const admin = { Authorization: `Bearer ${state.admin_token}` };
let member;
const reportPath = new URL('risk-checks.json', root);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

async function api(path, { headers = admin, body, method } = {}) {
  const response = await fetch('http://127.0.0.1:18080' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'), redirect: 'error',
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  assert.ok([0, 200].includes(value.status_code), `Local request refused: ${path.split('?')[0]} (${value.status_code})`);
  return value.data;
}
const stock = () => api(`/api/v1/admin/card-secrets/stats?product_id=${state.product_id}&sku_id=${state.sku_id}`);
const userPath = `/api/v1/admin/users/${account.id}`;
const productPath = `/api/v1/admin/products/${state.product_id}`;
const saved = await api('/api/v1/admin/settings?key=order_risk_control_config');
assert.deepEqual(saved, policy);
const product = await api(productPath);
assert.equal(product.is_active, false);
const user = await api(userPath);
assert.equal(user.status, 'disabled');
const before = await stock();
assert.equal(before.reserved, 0);
let order;
let observedMinutes;
try {
  await api(userPath, { method: 'PUT', body: { status: 'active' } });
  await api(productPath, { method: 'PATCH', body: { is_active: true } });
  const login = await api('/api/v1/auth/login', { headers: {}, body: { email: account.email, password: account.password } });
  member = { Authorization: `Bearer ${login.token}` };
  order = await api('/api/v1/orders', { headers: member, body: {
    items: [{ product_id: state.product_id, sku_id: state.sku_id, quantity: 1 }],
  } });
  observedMinutes = (new Date(order.expires_at) - new Date(order.created_at)) / 60000;
  assert.equal(observedMinutes, minutes);
  assert.equal((await stock()).reserved, 1);
} finally {
  try {
    if (order) {
      const canceled = await api(`/api/v1/orders/${encodeURIComponent(order.order_no)}/cancel`, { headers: member, body: {} });
      assert.equal(canceled.status, 'canceled');
    }
  } finally {
    try { await api(productPath, { method: 'PATCH', body: { is_active: false } }); }
    finally { await api(userPath, { method: 'PUT', body: { status: 'disabled' } }); }
  }
}
assert.deepEqual(await stock(), before);
assert.equal((await api(productPath)).is_active, false);
assert.equal((await api(userPath)).status, 'disabled');
report.deadline_change = {
  result: 'PASS', requested_minutes: minutes, checked_at: new Date().toISOString(),
  guest_saved_policy_minutes: saved.guest.payment_expire_minutes,
  member_created_order_minutes: observedMinutes, test_order_canceled: true,
  stock_restored: true, full_25_minute_wait_performed: false,
  source_sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
};
report.previous_final_policy = report.final_policy;
report.final_policy = saved;
report.expiry_test_scope = {
  real_background_timeout_observed_minutes: 1,
  final_guest_configured_minutes: minutes,
  final_member_minutes_verified_on_created_order: observedMinutes,
  final_full_deadline_background_wait_performed: false,
};
report.checked_at = report.deadline_change.checked_at;
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ result: 'PASS', guest_configured_minutes: minutes,
  member_order_minutes: observedMinutes, reserved_after_check: before.reserved, real_payments: 0 }));
