// Smoke test against the real build: starts `wrangler dev` on dist/ and checks every page for
// status codes, security headers and inline code the Content-Security-Policy would block.
// Usage: npm run build && npm run smoke
import { spawn } from 'node:child_process';

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
const HEADERS = [
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'x-frame-options',
];

const failures = [];
const fail = (msg) => failures.push(msg);

// Own process group (detached), so stopping it also stops wrangler's children (workerd).
// Killing only the parent leaves them running on Linux, and the CI step would never end.
const wrangler = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
const stopWrangler = () => {
  try {
    process.kill(-wrangler.pid, 'SIGTERM');
  } catch {
    // already gone
  }
};
// Safety net: never hang longer than this, whatever happens
const watchdog = setTimeout(() => {
  console.error('Smoke test timed out.');
  stopWrangler();
  process.exit(1);
}, 180_000);
let log = '';
wrangler.stdout.on('data', (d) => (log += d));
wrangler.stderr.on('data', (d) => (log += d));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    if (log.includes('Ready on')) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${log}`);
}

/** Inline code that a strict CSP (no 'unsafe-inline') would block. */
function inlineProblems(html) {
  const problems = [];
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) if (!/\ssrc=/.test(tag)) problems.push(`inline <script>: ${tag}`);
  if (/<style\b/.test(html)) problems.push('inline <style> block');
  if (/\sstyle="/.test(html)) problems.push('style="" attribute');
  const handler = html.match(/\son[a-z]+="/);
  if (handler) problems.push(`inline event handler: ${handler[0].trim()}`);
  return problems;
}

async function checkPage(path, expectedStatus, lang = 'de') {
  const res = await fetch(`${BASE}${path}`, { headers: { 'Accept-Language': lang }, redirect: 'manual' });
  if (res.status !== expectedStatus) fail(`${path}: status ${res.status}, expected ${expectedStatus}`);
  for (const name of HEADERS) if (!res.headers.has(name)) fail(`${path}: missing header ${name}`);
  const html = await res.text();
  for (const problem of inlineProblems(html)) fail(`${path}: ${problem}`);
  console.log(`${failures.length ? '…' : 'ok'} ${path} → ${res.status}`);
}

try {
  await waitForServer();

  const created = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Accepted by Turnstile's test secret (local .dev.vars); ignored when Turnstile is disabled (CI)
    body: JSON.stringify({ turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX', encrypted: false }),
  });
  if (created.status !== 201) throw new Error(`creating a room failed: ${created.status} ${await created.text()}`);
  const { code } = await created.json();

  await checkPage('/', 200);
  await checkPage('/', 200, 'en');
  await checkPage(`/${code}`, 200);
  await checkPage('/BCDFGH', 404);
  await checkPage('/nutzungsbedingungen', 200);
  await checkPage('/impressum', 200);
  await checkPage('/datenschutz', 200);
  await checkPage(`/admin/${code}?exp=1&sig=invalid`, 403);
} catch (e) {
  fail(String(e));
} finally {
  stopWrangler();
  clearTimeout(watchdog);
}

if (failures.length) {
  console.error(`\nSmoke test failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nSmoke test passed.');
process.exit(0);
