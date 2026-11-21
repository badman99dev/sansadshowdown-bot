'use strict';
// HTTP service for hosting the bot (e.g. on Render, region: singapore).
//   GET /                     -> dashboard
//   GET /join?code=ABCD&char=modi&diff=hard[&duration=180]
//   GET /sessions             -> JSON status of all sessions
//   GET /logs?id=<sid>        -> plain-text log for a session
//   GET /stop?id=<sid>        -> stop a session

const http = require('http');
const { startSession } = require('./session');

const sessions = new Map();
const PORT = process.env.PORT || 8080;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 6);

function gc() {
  for (const [id, s] of sessions) {
    if (s.state.ended && Date.now() - s.state.at > 10 * 60 * 1000) sessions.delete(id);
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function listSessions() {
  return [...sessions.values()].map((s) => s.status());
}

const PAGE = (base) => `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sansad Showdown Bot</title>
<style>
 body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#120a06;color:#f4e7d3;margin:0;padding:20px}
 h1{font-size:20px;margin:0 0 4px} .sub{opacity:.7;margin-bottom:16px;font-size:13px}
 .card{background:#1e130c;border:1px solid #3a2416;border-radius:12px;padding:16px;margin-bottom:16px;max-width:760px}
 input,select,button{font:inherit;padding:9px 12px;border-radius:9px;border:1px solid #4a2f1c;background:#2a1a10;color:#f4e7d3}
 input#code{text-transform:uppercase;letter-spacing:3px;width:110px}
 button{background:#e2601f;border-color:#e2601f;font-weight:700;cursor:pointer}
 button:hover{background:#ff7a33}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #2c1b11}
 th{opacity:.6;font-weight:600}
 code{background:#0d0704;padding:2px 6px;border-radius:5px}
 .ok{color:#7dd87d}.bad{color:#e77}.muted{opacity:.55}
 pre{background:#0d0704;padding:10px;border-radius:8px;overflow:auto;max-height:220px;font-size:12px}
 .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
</style></head><body>
<h1>🥊 Sansad Showdown Bot</h1>
<div class="sub">headless neta • joins a room by code • plays with the game's CPU brain (${base})</div>

<div class="card">
  <div class="row">
    <input id="code" maxlength="4" placeholder="CODE" autocomplete="off"/>
    <select id="char">
      ${['modi','rahul','didi','trump','yogi','nitin','ravi','lalu','amit','dhruv','mbapu']
        .map((c) => `<option value="${c}"${c === 'modi' ? ' selected' : ''}>${c}</option>`).join('')}
    </select>
    <select id="diff">
      <option value="hard" selected>hard</option><option value="normal">normal</option><option value="easy">easy</option>
    </select>
    <input id="dur" type="number" placeholder="secs (0=forever)" value="0" style="width:150px"/>
    <button onclick="join()">JOIN ROOM</button>
  </div>
  <div id="msg" class="sub" style="margin:10px 0 0"></div>
</div>

<div class="card">
  <div class="row" style="justify-content:space-between">
    <b>Sessions</b><button onclick="refresh()">Refresh</button>
  </div>
  <div id="list">loading…</div>
</div>

<div class="card">
  <b>Logs</b> <span class="muted">(click a session id above)</span>
  <pre id="logs">–</pre>
</div>

<script>
async function join(){
  const code=document.getElementById('code').value.trim();
  const char=document.getElementById('char').value;
  const diff=document.getElementById('diff').value;
  const duration=document.getElementById('dur').value||0;
  const m=document.getElementById('msg');
  m.textContent='joining…';
  try{
    const r=await fetch('/join?code='+encodeURIComponent(code)+'&char='+char+'&diff='+diff+'&duration='+duration);
    const j=await r.json();
    m.innerHTML = j.error ? '<span class="bad">'+j.error+'</span>' : 'session <code>'+j.id+'</code> started';
    refresh();
  }catch(e){ m.innerHTML='<span class="bad">'+e+'</span>'; }
}
async function refresh(){
  const r=await fetch('/sessions'); const rows=await r.json();
  if(!rows.length){document.getElementById('list').textContent='no sessions';return;}
  let h='<table><tr><th>id</th><th>code</th><th>me</th><th>opp</th><th>status</th><th>hp</th><th>timer</th><th>rtt</th><th></th></tr>';
  for(const s of rows){
    h+='<tr><td><a href="#" onclick="logs(\\''+s.id+'\\');return false"><code>'+s.id+'</code></a></td>'
      +'<td>'+s.code+'</td><td>'+(s.char||'?')+'</td><td>'+(s.opp||'?')+'</td>'
      +'<td class="'+(s.ended?'muted':(s.status==='fighting'?'ok':''))+ '">'+s.status+(s.error?' ('+s.error+')':'')+'</td>'
      +'<td>'+s.ourHp+' vs '+s.oppHp+'</td><td>'+s.timer+'</td><td>'+(s.rtt??'-')+'ms</td>'
      +'<td>'+(s.ended?'':'<button onclick="stop(\\''+s.id+'\\')">stop</button>')+'</td></tr>';
  }
  document.getElementById('list').innerHTML=h+'</table>';
}
async function stop(id){ await fetch('/stop?id='+id); refresh(); }
async function logs(id){
  const r=await fetch('/logs?id='+id); const t=await r.text();
  const el=document.getElementById('logs'); el.textContent=t; el.scrollTop=el.scrollHeight;
}
setInterval(()=>{ refresh(); },5000);
refresh();
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE('v1.0'));
  }

  if (p === '/join') {
    gc();
    const code = url.searchParams.get('code');
    const active = [...sessions.values()].filter((s) => !s.state.ended).length;
    if (!code) return json(res, 400, { error: 'missing ?code=' });
    if (active >= MAX_SESSIONS) return json(res, 429, { error: 'too many active sessions' });
    const s = startSession({
      code,
      char: url.searchParams.get('char') || 'modi',
      diff: url.searchParams.get('diff') || 'hard',
      name: url.searchParams.get('name') || 'neta',
      duration: Number(url.searchParams.get('duration')) || 0,
      predict: url.searchParams.get('predict') !== '0',
      log: () => {},
    });
    sessions.set(s.id, s);
    return json(res, 200, { id: s.id, code: s.state.cfg.code, status: 'connecting' });
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

  if (p === '/health') return json(res, 200, { ok: true, sessions: sessions.size });

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`sansadshowdown-bot listening on :${PORT}`));
