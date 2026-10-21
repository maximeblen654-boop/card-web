import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const allowed = /^(?:\.gitignore|\.gitattributes|README\.md|upstream\.lock\.json|\.github\/workflows\/[\w-]+\.yml|scripts\/[\w-]+\.(?:mjs|sh)|local-shop\/(?:Start-LocalShop\.ps1|Stop-LocalShop\.ps1|启动测试商城\.cmd|停止测试商城\.cmd|使用说明\.txt)|local-shop\/testing\/[\w-]+\.mjs)$/u;
const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
for (const file of files) {
  if (!allowed.test(file)) throw new Error(`Unreviewed file: ${file}`);
  if (statSync(file).size > 1024 * 1024) throw new Error(`Unexpected large source: ${file}`);
  const text = readFileSync(file, 'utf8');
  if (secretPatterns.some(pattern => pattern.test(text))) throw new Error(`Possible credential: ${file}`);
  if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}
const lock = JSON.parse(readFileSync('upstream.lock.json', 'utf8'));
if (lock.repository !== 'dujiao-next/dujiao-next' || !/^[a-f0-9]{40}$/.test(lock.commit) ||
    !/^v\d+\.\d+\.\d+$/.test(lock.version) || lock.build_type !== 'custom') {
  throw new Error('Invalid upstream identity');
}
console.log(`Reviewed source files: ${files.length}; JavaScript syntax and repository boundary OK.`);
