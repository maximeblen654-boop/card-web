// Local simulation only. This service never contacts a payment provider.
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function readMockConfig() {
  const config = JSON.parse(readFileSync(new URL('../runtime/mock-payment.json', import.meta.url), 'utf8'));
  if (config.local_test_only !== true || config.host !== '127.0.0.1' ||
      config.port !== 18081 || config.shop_origin !== 'http://127.0.0.1:18080') {
    throw new Error('Mock payment must use the fixed local-only addresses');
  }
  return config;
}

// Matches Dujiao-Next v1.5.0's EPay v1 signing format.
export function sign(fields, key) {
  const text = Object.keys(fields).filter(k => k !== 'sign' && k !== 'sign_type' && fields[k] !== '')
    .sort().map(k => `${k}=${fields[k]}`).join('&');
  return createHash('md5').update(text + key, 'utf8').digest('hex');
}

export function callbackFields(payment, config) {
  const fields = { pid: config.merchant_id, type: payment.type, out_trade_no: payment.out_trade_no,
    trade_no: `LOCAL-${payment.out_trade_no}`, money: payment.money, name: payment.name,
    trade_status: 'TRADE_SUCCESS', sign_type: 'MD5' };
  return { ...fields, sign: sign(fields, config.merchant_key) };
}

const escape = value => String(value).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

export function startMockPayment() {
  const config = readMockConfig();
  const pending = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== `${config.host}:${config.port}`) return send(res, 403, 'Local host required');
      const url = new URL(req.url, `http://${config.host}:${config.port}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, JSON.stringify({ status: 'ok', mock: 'epay-local' }), 'application/json');
      }
      if (req.method === 'GET' && url.pathname === '/submit.php') {
        const keys = [...url.searchParams.keys()];
        if (new Set(keys).size !== keys.length) return send(res, 400, 'Duplicate parameters');
        const payment = Object.fromEntries(url.searchParams);
        const expected = Buffer.from(sign(payment, config.merchant_key));
        const actual = Buffer.from(payment.sign || '');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected) ||
            payment.pid !== config.merchant_id || payment.sign_type !== 'MD5' ||
            !/^[A-Za-z0-9_-]{1,96}$/.test(payment.out_trade_no || '') ||
            !/^\d{1,5}(\.\d{1,2})?$/.test(payment.money || '') || Number(payment.money) <= 0 ||
            payment.notify_url !== `${config.shop_origin}/api/v1/payments/callback` ||
            new URL(payment.return_url).origin !== config.shop_origin) {
          return send(res, 400, 'Invalid local simulation request');
        }
        for (const [token, item] of pending) if (Date.now() - item.created > 3600000) pending.delete(token);
        if (pending.size >= 100) return send(res, 429, 'Too many local test sessions');
        const token = randomBytes(24).toString('hex');
        pending.set(token, { payment, created: Date.now() });
        return send(res, 200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1"><title>本地模拟收银台</title>
          <style>body{font:18px/1.7 system-ui;background:#f4f6f8;margin:0;color:#18212f}main{max-width:560px;margin:12vh auto;padding:32px;background:white;border-radius:18px}button{font:inherit;background:#176bdf;color:white;border:0;border-radius:9px;padding:12px 22px;cursor:pointer}small{color:#64748b}</style>
          <main><h1>本地模拟付款</h1><p>这是演练，不会扣款。确认后，商城将按正式程序校验通知并自动发出一条假卡密。</p>
          <p>演示金额：${escape(payment.money)} CNY<br>测试单号：${escape(payment.out_trade_no)}</p>
          <form method="post" action="/confirm"><input type="hidden" name="token" value="${token}">
          <button type="submit">确认模拟付款（不收钱）</button></form><p><small>仅供本机测试，请勿配置到正式商城。</small></p></main></html>`);
      }
      if (req.method === 'POST' && url.pathname === '/confirm') {
        if (req.headers.origin && req.headers.origin !== `http://${config.host}:${config.port}`) return send(res, 403, 'Origin mismatch');
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString('utf8');
          if (body.length > 2048) return send(res, 413, 'Request too large');
        }
        const item = pending.get(new URLSearchParams(body).get('token'));
        if (!item || Date.now() - item.created > 3600000) return send(res, 404, 'Test session expired');
        const response = await fetch(`${config.shop_origin}/api/v1/payments/callback`, {
          method: 'POST', body: new URLSearchParams(callbackFields(item.payment, config)),
          redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (!response.ok || (await response.text()).trim() !== 'success') return send(res, 502, '商城尚未确认，请返回后重试原订单。');
        res.writeHead(303, { Location: item.payment.return_url, 'Cache-Control': 'no-store' });
        return res.end();
      }
      send(res, 404, 'Local mock payment only');
    } catch { send(res, 500, 'Local simulation failed; inspect local test configuration'); }
  });
  server.listen(config.port, config.host, () => console.log('Local mock payment ready on 127.0.0.1:18081'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startMockPayment();
