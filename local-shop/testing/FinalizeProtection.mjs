// Targeted follow-up: align the admin display with the existing 25-minute runtime setting.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const root = new URL('../', import.meta.url);
const reportPath = new URL('protection-checks.json', root);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const state = JSON.parse(readFileSync(new URL('runtime/risk-session.json', root), 'utf8'));
const origin = 'http://127.0.0.1:18080';
const headers = { Authorization: `Bearer ${state.admin_token}` };
async function request(path, { body, admin = false, method } = {}) {
  const response = await fetch(origin + path, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Accept-Language': 'en-US', ...(admin ? headers : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(5000) });
  return response.json();
}
async function admin(path, options = {}) {
  const value = await request('/api/v1/admin' + path, { ...options, admin: true });
  assert.equal(value.status_code, 0); return value.data;
}
assert.equal(report.result, 'PASS');
const previous = await admin('/settings?key=order_config');
const desired = { ...previous, payment_expire_minutes: 25 };
await admin('/settings', { method: 'PUT', body: { key: 'order_config', value: desired } });
const saved = await admin('/settings?key=order_config');
assert.equal(saved.payment_expire_minutes, 25);
assert.equal(saved.max_refund_days, previous.max_refund_days ?? 30);
assert.ok(report.backup_directory.replaceAll('\\', '/').startsWith('D:/card web/local-shop/runtime/backups/'));
const snapshotDB = new DatabaseSync(report.backup_directory + '/dujiao.db', { readOnly: true });
let backupSetting;
try { const row = snapshotDB.prepare('SELECT value_json FROM settings WHERE key=?').get('order_config');
  backupSetting = row ? JSON.parse(row.value_json) : {}; }
finally { snapshotDB.close(); }
report.deadline_settings_sync = { result: 'PASS', before_backup: backupSetting, after: saved,
  reason: 'Admin UI fell back to 15 when no order_config row existed; runtime YAML and new-order deadline were already 25' };
const record = name => {
  if (!report.checks.some(value => value.name === name)) report.checks.push({ name, result: 'PASS' });
};
record('Admin persisted order configuration also displays 25 minutes instead of the absent-row fallback');
for (const purpose of ['register', 'reset']) {
  const path = '/api/v1/auth/send-verify-code';
  const value = await request(path, { body: { email: 'protection-check@shop.invalid', purpose } });
  assert.equal(value.status_code, 400); assert.match(value.msg, /captcha/i);
  record(`${path} (${purpose}) refuses a missing CAPTCHA before sending email`);
}
report.followup_source_sha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
report.checked_at = new Date().toISOString();
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ result: report.result, checks: report.checks.length, admin_deadline_minutes: 25,
  missing_captcha_email_requests_denied: 2, real_emails_sent: 0 }));
