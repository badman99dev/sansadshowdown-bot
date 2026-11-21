'use strict';
// Load test: stand up N fake hosts, join N rooms at once, verify capacity + the
// 9th join is rejected. Run the server first (MAX_SESSIONS=8), then:
//   BASE=http://127.0.0.1:8099 node loadtest.js 8
const { spawn } = require('child_process');
const path = require('path');

const N = Number(process.argv[2] || 8);
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnHost(i) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'selftest.js'), 'modi', 'rahul'],
      { env: { ...process.env, FK_HOST_ONLY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const to = setTimeout(() => reject(new Error('host ' + i + ' timeout')), 60000);
    p.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/room created: ([A-Z0-9]{4})/);
      if (m && /offer sent/.test(buf)) { clearTimeout(to); resolve({ p, code: m[1] }); }
    });
    p.stderr.on('data', () => {});
  });
}

(async () => {
  console.log(`spawning ${N} fake hosts...`);
  const hosts = [];
  for (let i = 0; i < N; i++) hosts.push(await spawnHost(i));
  console.log('codes:', hosts.map((h) => h.code).join(' '));

  const ids = [];
  for (const h of hosts) {
    const r = await fetch(`${BASE}/join?code=${h.code}&diff=hard`).then((r) => r.json()).catch((e) => ({ error: e.message }));
    ids.push(r.id);
    console.log('  join', h.code, '->', r.id || JSON.stringify(r));
  }

  await sleep(7000);
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log('health:', JSON.stringify(health));

  const ses = await fetch(`${BASE}/sessions`).then((r) => r.json());
  const live = ses.filter((s) => !s.ended);
  console.log(`live sessions: ${live.length}  statuses: ${live.map((s) => s.status).join(',')}`);
  console.log(`  fighting: ${live.filter((s) => s.status === 'fighting').length}`);

  const extra = await fetch(`${BASE}/join?code=ZZZZ`).then(async (r) => ({ status: r.status, body: await r.json() }));
  console.log('extra (9th) join ->', extra.status, JSON.stringify(extra.body));

  for (const h of hosts) { try { h.p.kill('SIGINT'); } catch {} }
  setTimeout(() => process.exit(0), 1500);
})().catch((e) => { console.error('LOADTEST FAIL:', e.message); process.exit(1); });
