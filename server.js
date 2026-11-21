'use strict';
// Control service for hosting the bot (e.g. on Render, region: singapore).
//
//   HTTP                            WebSocket (ws://<host>/ws)
//   ----                            -------------------------
//   GET /                           dashboard      {t:'join', code, char, diff, ...}
//   GET /join?code=..&char=..       start session  {t:'pause'|'resume'|'toggle', id}
//   GET /sessions                   JSON list      {t:'level', id, diff, overrides}
//   GET /logs?id=..                 plain log      {t:'char', id, char}
//   GET /stop?id=..                 stop session   {t:'stop', id}
//   GET /health                     health         {t:'list'}
//
// The controller is just any WebSocket client: send a room code to launch the
// bot, pause/resume it, and change its CPU level live.

const http = require('http');
const { WebSocketServer } = require('ws');
const { startSession, LEVELS } = require('./session');
const { PROFILES, DEFAULT_LEVEL } = require('./ai');
const proto = require('./proto');

const sessions = new Map();
const clients = new Set();
const PORT = process.env.PORT || 8080;
// Capacity: rooms served at once. Default 3 (safe on Render's free 0.1-CPU plan);
// raise it with the MAX_SESSIONS env var on a bigger instance.
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 3);
const CHARS = ['modi', 'rahul', 'didi', 'trump', 'yogi', 'nitin', 'ravi', 'lalu', 'amit', 'dhruv', 'mbapu'];
const OVERRIDE_KEYS = ['aggression', 'reaction', 'blockChance', 'punishChance', 'breakChance', 'superChance', 'bossRead'];

function gc() {
  for (const [id, s] of sessions) {
    if (s.state.ended && Date.now() - s.state.at > 10 * 60 * 1000) sessions.delete(id);
  }
}

function listSessions() { return [...sessions.values()].map((s) => s.status()); }

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

function sendTo(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } }
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of clients) if (ws.readyState === 1) { try { ws.send(s); } catch {} } }

// which controller owns each session (null = created over HTTP, open to anyone)
const owner = new Map();

// route a session's events: private ones (logs) go to its controller only;
// status/over/list go to everyone
function route(s) {
  s.subscribe((ev) => {
    if (ev.t === 'log') {
      const o = owner.get(s.id);
      if (o && o.readyState === 1) sendTo(o, ev); else broadcast(ev);
    } else {
      if (ev.t === 'over') owner.delete(s.id);
      broadcast(ev);
    }
  });
}

function createSession(ws, p) {
  gc();
  const active = [...sessions.values()].filter((s) => !s.state.ended).length;
  if (active >= MAX_SESSIONS) {
    sendTo(ws, { t: 'error', message: `server full — ${MAX_SESSIONS} rooms max, try again later` });
    return null;
  }
  const overrides = p.overrides && typeof p.overrides === 'object' ? pickOverrides(p.overrides) : undefined;
  const s = startSession({
    code: p.code,
    char: p.char || 'modi',
    diff: p.diff || DEFAULT_LEVEL,
    name: p.name || 'neta',
    duration: Number(p.duration) || 0,
    hz: Number(p.hz) || 60,
    predict: p.predict !== false && p.predict !== '0',
    overrides,
  });
  s.setLevel(s.state.level, overrides);
  sessions.set(s.id, s);
  const isWs = ws && ws.readyState === 1;
  owner.set(s.id, isWs ? ws : null);
  // route each session's log lines to its own controller; status goes to everyone
  route(s);
  sendTo(ws, { t: 'joined', id: s.id, code: s.status().code, status: s.status().status });
  broadcast({ t: 'sessions', sessions: listSessions(), max: MAX_SESSIONS });
  return s;
}

function pickOverrides(o) {
  const out = {};
  for (const k of OVERRIDE_KEYS) if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = Number(o[k]);
  return Object.keys(out).length ? out : undefined;
}

// a controller may drive its own sessions (HTTP-created sessions are open to all)
function canControl(ws, id) {
  const o = owner.get(id);
  return !o || o === ws;
}

function handleControl(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  switch (m.t) {
    case 'hello':
    case 'list':
      sendTo(ws, { t: 'hello', ok: true, levels: LEVELS, profiles: PROFILES, chars: CHARS, overrideKeys: OVERRIDE_KEYS, sessions: listSessions(), max: MAX_SESSIONS });
      break;
    case 'join':
      if (!m.code) return sendTo(ws, { t: 'error', message: 'missing code' });
      createSession(ws, m);
      break;
    case 'pause': case 'resume': case 'toggle': {
      const s = sessions.get(m.id);
      if (!s) return sendTo(ws, { t: 'error', message: 'no such session', id: m.id });
      if (!canControl(ws, m.id)) return sendTo(ws, { t: 'error', message: 'not your session', id: m.id });
      if (m.t === 'pause') s.pause(); else if (m.t === 'resume') s.resume(); else s.toggle();
      sendTo(ws, { t: 'ok', id: m.id, action: m.t, paused: s.status().paused });
      broadcast({ t: 'sessions', sessions: listSessions() });
      break;
    }
    case 'level': {
      const s = sessions.get(m.id);
      if (!s) return sendTo(ws, { t: 'error', message: 'no such session', id: m.id });
      if (m.diff && !LEVELS.includes(m.diff)) return sendTo(ws, { t: 'error', message: 'bad level' });
      const ov = m.overrides ? pickOverrides(m.overrides) : undefined;
      const lvl = s.setLevel(m.diff, ov);
      sendTo(ws, { t: 'ok', id: m.id, action: 'level', diff: lvl });
      broadcast({ t: 'sessions', sessions: listSessions() });
      break;
    }
    case 'char': {
      const s = sessions.get(m.id);
      if (!s) return sendTo(ws, { t: 'error', message: 'no such session', id: m.id });
      s.setChar(m.char);
      sendTo(ws, { t: 'ok', id: m.id, action: 'char', char: m.char });
      break;
    }
    case 'hz': {
      const s = sessions.get(m.id);
      if (!s) return sendTo(ws, { t: 'error', message: 'no such session', id: m.id });
      const hz = s.setHz(m.hz);
      sendTo(ws, { t: 'ok', id: m.id, action: 'hz', hz });
      break;
    }
    case 'stop': {
      const s = sessions.get(m.id);
      if (!s) return sendTo(ws, { t: 'error', message: 'no such session', id: m.id });
      if (!canControl(ws, m.id)) return sendTo(ws, { t: 'error', message: 'not your session', id: m.id });
      s.stop();
      sendTo(ws, { t: 'ok', id: m.id, action: 'stop' });
      broadcast({ t: 'sessions', sessions: listSessions() });
      break;
    }
    case 'logs': {
      const s = sessions.get(m.id);
      sendTo(ws, { t: 'logs', id: m.id, lines: s ? s.lines() : [] });
      break;
    }
    default:
      sendTo(ws, { t: 'error', message: 'unknown type: ' + m.t });
  }
}

// ---------------------------------------------------------------- dashboard
const PAGE = (base) => `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sansad Showdown Bot</title>
<style>
 body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#120a06;color:#f4e7d3;margin:0;padding:20px}
 h1{font-size:20px;margin:0 0 4px} .sub{opacity:.7;margin-bottom:16px;font-size:13px}
 .card{background:#1e130c;border:1px solid #3a2416;border-radius:12px;padding:16px;margin-bottom:16px;max-width:900px}
 input,select,button{font:inherit;padding:9px 12px;border-radius:9px;border:1px solid #4a2f1c;background:#2a1a10;color:#f4e7d3}
 input#code{text-transform:uppercase;letter-spacing:3px;width:104px}
 input.mini{width:82px}
 button{background:#e2601f;border-color:#e2601f;font-weight:700;cursor:pointer}
 button:hover{background:#ff7a33}
 button.sm{padding:5px 9px;font-size:12px;background:#2a1a10;border-color:#4a2f1c;font-weight:600}
 button.sm:hover{background:#3a2416}
 button.warn{background:#7a2a2a;border-color:#7a2a2a}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #2c1b11;white-space:nowrap}
 th{opacity:.6;font-weight:600}
 code{background:#0d0704;padding:2px 6px;border-radius:5px}
 .ok{color:#7dd87d}.bad{color:#e77}.muted{opacity:.55}.warnc{color:#f5c26b}
 pre{background:#0d0704;padding:10px;border-radius:8px;overflow:auto;max-height:260px;font-size:12px;margin:0}
 .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
 .dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#e77}
 .dot.on{background:#7dd87d}
 details{margin-top:8px} summary{cursor:pointer;opacity:.7;font-size:13px}
 .adv{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
 label{font-size:11px;opacity:.6;display:block}
</style></head><body>
<h1>🥊 Sansad Showdown Bot</h1>
<div class="sub"><span class="dot" id="dot"></span> control socket <span id="wsstate">connecting…</span> • headless neta • ${base}</div>

<div class="card">
  <div class="row">
    <input id="code" maxlength="4" placeholder="CODE" autocomplete="off"/>
    <select id="char">${CHARS.map((c) => `<option${c === 'modi' ? ' selected' : ''}>${c}</option>`).join('')}</select>
    <select id="diff"><option>ultimate</option></select>
    <input id="dur" class="mini" type="number" placeholder="secs" value="0"/>
    <input id="hz" class="mini" type="number" placeholder="hz" value="60"/>
    <button onclick="join()">JOIN ROOM</button>
  </div>
  <details>
    <summary>custom CPU tuning (optional — leave blank to use the level's defaults)</summary>
    <div class="adv">${OVERRIDE_KEYS.map((k) => `<div><label>${k}</label><input id="ov_${k}" class="mini" type="number" step="0.01" placeholder="—"/></div>`).join('')}</div>
  </details>
  <div id="msg" class="sub" style="margin:10px 0 0"></div>
</div>

<div class="card">
  <div class="row" style="justify-content:space-between"><b>Sessions</b><span id="cap" class="muted"></span><button class="sm" onclick="send({t:'list'})">Refresh</button></div>
  <div id="list" class="sub" style="margin-top:10px">no sessions</div>
</div>

<div class="card">
  <div class="row" style="justify-content:space-between"><b>Live log</b><button class="sm" onclick="document.getElementById('logs').textContent=''">clear</button></div>
  <pre id="logs">–</pre>
</div>

<script>
let ws=null, retry=0, MAX=8, LEVELS_LIST=['easy','normal','ultimate'];
function connect(){
  const proto2 = location.protocol==='https:'?'wss':'ws';
  ws = new WebSocket(proto2+'://'+location.host+'/ws');
  ws.onopen = ()=>{ retry=0; setDot(true,'connected'); };
  ws.onclose = ()=>{ setDot(false,'reconnecting…'); setTimeout(connect, Math.min(5000, 500*(++retry))); };
  ws.onerror = ()=>{};
  ws.onmessage = (e)=>{ let m; try{m=JSON.parse(e.data);}catch{return;} onMsg(m); };
}
function setDot(on,txt){ document.getElementById('dot').className='dot'+(on?' on':''); document.getElementById('wsstate').textContent=txt; }
function send(o){ if(ws && ws.readyState===1) ws.send(JSON.stringify(o)); else msg('socket not connected','bad'); }
function msg(t,cls){ const m=document.getElementById('msg'); m.innerHTML = cls?'<span class="'+cls+'">'+t+'</span>':t; }

function onMsg(m){
  if(m.t==='welcome'||m.t==='hello'||m.t==='sessions'){ if(m.max) MAX=m.max; if(m.levels){ LEVELS_LIST=m.levels; fillLevelSelect(); } if(m.sessions){ render(m.sessions); capacity(m.sessions); } }
  else if(m.t==='joined'){ msg('session <code>'+m.id+'</code> started'); }
  else if(m.t==='log'){ const el=document.getElementById('logs'); if(el.textContent==='–')el.textContent=''; el.textContent+=m.line+'\\n'; el.scrollTop=el.scrollHeight; }
  else if(m.t==='error'){ msg(m.message||'error','bad'); }
}

function join(){
  const ov={};
  for(const k of ${JSON.stringify(OVERRIDE_KEYS)}){ const v=document.getElementById('ov_'+k).value; if(v!=='') ov[k]=Number(v); }
  const p={ t:'join', code:document.getElementById('code').value.trim().toUpperCase(),
    char:document.getElementById('char').value, diff:document.getElementById('diff').value,
    duration:Number(document.getElementById('dur').value)||0, hz:Number(document.getElementById('hz').value)||60 };
  if(Object.keys(ov).length) p.overrides=ov;
  msg('joining…');
  send(p);
}
function pause(id){ send({t:'toggle', id}); }
function stop(id){ send({t:'stop', id}); }
function setLevel(id, el){ send({t:'level', id, diff:el.value}); }

function render(rows){
  const el=document.getElementById('list');
  if(!rows.length){ el.textContent='no sessions'; return; }
  let h='<table><tr><th>id</th><th>code</th><th>me</th><th>opp</th><th>status</th><th>level</th><th>hp</th><th>timer</th><th>pkt/s</th><th>rtt</th><th>controls</th></tr>';
  for(const s of rows){
    const pps = s.ageSec>0 ? (s.packets/Math.max(1,s.ageSec)).toFixed(0) : '-';
    const st = s.ended?'muted':(s.status==='fighting'?'ok':(s.status==='paused'?'warnc':''));
    h+='<tr>'
      +'<td><code>'+s.id+'</code></td><td>'+s.code+'</td><td>'+(s.char||'?')+'</td><td>'+(s.opp||'?')+'</td>'
      +'<td class="'+st+'">'+s.status+(s.error?' ('+s.error+')':'')+'</td>'
      +'<td>'+(s.ended?escapeHtml(s.level||''):'<select onchange="setLevel(\\''+s.id+'\\',this)">'+LEVELS_LIST.map(l=>'<option'+(l===s.level?' selected':'')+'>'+l+'</option>').join('')+'</select>')+'</td>'
      +'<td>'+s.ourHp+' vs '+s.oppHp+'</td><td>'+s.timer+'</td><td>'+pps+'</td><td>'+(s.rtt??'-')+'ms</td>'
      +'<td>'+(s.ended?'<span class="muted">ended</span>':'<button class="sm" onclick="pause(\\''+s.id+'\\')">'+(s.paused?'▶ resume':'⏸ pause')+'</button> <button class="sm warn" onclick="stop(\\''+s.id+'\\')">stop</button>')+'</td>'
      +'</tr>';
  }
  el.innerHTML=h+'</table>';
}
function escapeHtml(s){ return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function capacity(rows){
  const live=rows.filter(r=>!r.ended).length;
  document.getElementById('cap').textContent=' '+live+'/'+MAX+' rooms';
}
function fillLevelSelect(){
  const sel=document.getElementById('diff');
  if(!sel) return;
  const cur=sel.value||'ultimate';
  sel.innerHTML=LEVELS_LIST.map(l=>'<option'+(l===cur?' selected':'')+'>'+l+'</option>').join('');
}
fillLevelSelect();
connect();
</script></body></html>`;

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE('v1.2'));
  }

  if (p === '/join') {
    const code = url.searchParams.get('code');
    if (!code) return json(res, 400, { error: 'missing ?code=' });
    const fake = { readyState: 0 };
    const s = createSession(fake, {
      code,
      char: url.searchParams.get('char') || 'modi',
      diff: url.searchParams.get('diff') || DEFAULT_LEVEL,
      name: url.searchParams.get('name') || 'neta',
      duration: Number(url.searchParams.get('duration')) || 0,
      hz: Number(url.searchParams.get('hz')) || 60,
      predict: url.searchParams.get('predict') !== '0',
    });
    if (!s) return json(res, 429, { error: `server full — ${MAX_SESSIONS} rooms max, try again later` });
    return json(res, 200, { id: s.id, code: s.status().code, status: s.status().status });
  }

  if (p === '/sessions') return json(res, 200, listSessions());

  if (p === '/logs') {
    const s = sessions.get(url.searchParams.get('id'));
    if (!s) return json(res, 404, { error: 'no such session' });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(s.lines().join('\n'));
  }

  if (p === '/stop') {
    const s = sessions.get(url.searchParams.get('id'));
    if (!s) return json(res, 404, { error: 'no such session' });
    s.stop();
    return json(res, 200, { id: s.id, status: 'stopped' });
  }

  if (p === '/health') {
    const active = [...sessions.values()].filter((s) => !s.state.ended).length;
    return json(res, 200, { ok: true, sessions: sessions.size, active, max: MAX_SESSIONS, clients: clients.size });
  }

  json(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  sendTo(ws, {
    t: 'welcome', ok: true, levels: LEVELS, profiles: PROFILES, chars: CHARS,
    levels: LEVELS, overrideKeys: OVERRIDE_KEYS, sessions: listSessions(), max: MAX_SESSIONS,
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    try { handleControl(ws, m); } catch (e) { sendTo(ws, { t: 'error', message: e.message }); }
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

const bcastTimer = setInterval(() => {
  gc();
  broadcast({ t: 'sessions', sessions: listSessions(), max: MAX_SESSIONS });
}, 1000);

server.listen(PORT, () => console.log(`sansadshowdown-bot listening on :${PORT} (control: ws://<host>:${PORT}/ws)`));

module.exports = { server, wss };
