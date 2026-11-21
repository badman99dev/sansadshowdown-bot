# sansadshowdown-bot

Headless bot for **fightkaro.com — Sansad Showdown** online 1v1.

It joins a friend's room by its **4-character code** and plays the match using the
game's *own* CPU brain (the same AI that drives the in-game bot, `hard` profile),
driven by live match snapshots received over WebRTC.

No browser. Pure Node.js. Speaks the game's real WebRTC + DataChannel protocol
(`werift` for WebRTC, plain `ws` for signaling probes).

---

## How it works

```
                 signaling (https + ws)
  bot  ───────────────────────────────────►  fightkaro.com
   │   GET  /api/room/join?code=ABCD              │
   │   POST /api/room/answer?code=ABCD            │
   │                                              │
   │   WebRTC (DTLS/SRTP + SCTP DataChannels)     │
   │   ◄──────── ctrl  (JSON, ordered) ────────►  │  host browser
   │   ◄──────── input (binary/JSON) ─────────►   │
```

* **Guest** (this bot) joins via the HTTP signaling endpoints above.
* Two negotiated DataChannels:
  * `ctrl` (id 0, ordered) — lobby/start/ping-pong/events as JSON.
  * `input` (id 1, unordered, `maxRetransmits:0`) — bot → host: raw binary input
    frames; host → bot: JSON snapshots of the match state.
* The bot replies to the host's keepalive `ping` with `pong` and pushes input
  packets at **60 Hz** so the host never times the peer out.
* Every snapshot is converted to a `fighter` object and fed to the ported CPU
  brain (`ai.js`), which returns an input for that tick.

### Input packet format

```
[u8 version=1][u32 seq (BE)][u8 count][count × u8 frame]
```
Each frame is a bitmask: bits 0-1 = moveX, bit2 up, bit3 down, bit4 punch,
bit5 kick, bit6 grab, bit7 super. The bot sends a rolling window (up to 8 frames)
each tick for loss tolerance on the unreliable channel.

---

## Run locally

```bash
npm install

# join a room (the friend must be hosting on fightkaro.com and share the code)
node index.js --code ABCD --char modi --diff hard --name neta
```

### CLI options

| flag | default | meaning |
|---|---|---|
| `--code` / `-c` | — | **required** 4-char room code |
| `--char` | `modi` | fighter to pick |
| `--diff` / `-d` | `hard` | `easy` \| `normal` \| `hard` \| `extreme` \| `ultimate` |
| `--name` | `neta` | tag shown in the lobby |
| `--url` | `https://fightkaro.com` | base URL |
| `--duration` | `0` | stop after N seconds (0 = until the match/room ends) |
| `--no-predict` | off | disable snapshot lag-prediction |

---

## HTTP service (for hosting)

```bash
npm start           # listens on $PORT (default 8080)
```

| route | description |
|---|---|
| `GET /` | dashboard: enter a code, hit **JOIN ROOM**, then pause/resume/change level live over the WebSocket |
| `GET /join?code=ABCD&char=modi&diff=hard&duration=0` | start a session, returns `{ id }` |
| `GET /sessions` | JSON list of all sessions with live status |
| `GET /logs?id=<sid>` | plain-text log for a session |
| `GET /stop?id=<sid>` | stop a session |
| `GET /health` | health probe — `{ ok, sessions, active, max, clients }` |

---

## Control over WebSocket (`/ws`)

The person who has the room code connects to `ws://<host>/ws` and drives the bot
from there — **send a room code to launch it, pause/resume mid-fight, and change
its CPU level live**. Any WebSocket client works (dashboard, phone app, chat bot).

On connect the server pushes a `welcome` (catalog + current sessions). Then:

**Client → server**

| message | effect |
|---|---|
| `{t:'join', code, char?, diff?, name?, duration?, hz?, predict?, overrides?}` | join a room and start playing |
| `{t:'pause', id}` / `{t:'resume', id}` / `{t:'toggle', id}` | pause / resume (fighter goes idle) |
| `{t:'level', id, diff?, overrides?}` | change difficulty **mid-match** |
| `{t:'char', id, char}` | change fighter (before start it re-sends the lobby) |
| `{t:'hz', id, hz}` | change the input send rate (10–120) |
| `{t:'stop', id}` | end the session |
| `{t:'list'}` | ask for the current sessions |

**Server → client**

| message | meaning |
|---|---|
| `{t:'welcome'}` / `{t:'hello'}` | catalog: `levels`, `profiles`, `chars`, `charAi`, `overrideKeys`, `sessions` |
| `{t:'joined', id, code, status}` | session created |
| `{t:'ok', id, action, ...}` | command applied |
| `{t:'error', message, id?}` | command rejected |
| `{t:'sessions', sessions:[…]}` | live state, pushed every second |
| `{t:'log', id, line}` | live log line for a session |
| `{t:'over', id, status}` | session ended |

### Difficulty levels

**Every character uses the same brain** — behaviour depends only on the level
(and optional custom tuning), never on who you picked. `easy`/`normal`/`hard` are
the game's own profiles (`i_` in the bundle); `extreme` and `ultimate` are crafted
on top of `hard`.

| level | reaction | block | punish | break | aggression | super |
|---|---|---|---|---|---|---|
| `easy` | 0.42s | 18% | 20% | 8% | 45% | 35% |
| `normal` *(game default)* | 0.26s | 45% | 50% | 30% | 65% | 70% |
| `hard` | 0.14s | 75% | 85% | 60% | 80% | 100% |
| `extreme` | 0.08s | 92% | 96% | 85% | 92% | 100% |
| `ultimate` | 0.05s | 100% | 100% | 100% | 100% | 100% |

* `reaction` is the decision interval — smaller is snappier.
* Optional `overrides: { aggression, reaction, blockChance, punishChance, breakChance, superChance, bossRead }`
  layer on top of any level for fully custom behaviour.

> Latency caps real skill: at ~140 ms RTT the bot can't react frame-perfect even at
> `ultimate`. Run it close to the host (Singapore for India) for the best result.

### Example client

```js
const ws = new WebSocket('ws://localhost:8080/ws');
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'join', code: 'ABCD', diff: 'hard' }));
  if (m.t === 'joined') {
    setTimeout(() => ws.send(JSON.stringify({ t: 'pause', id: m.id })), 5000);   // freeze it
    setTimeout(() => ws.send(JSON.stringify({ t: 'level', id: m.id, diff: 'easy' })), 8000);
  }
};
```

`controltest.js` is a ready-made client that joins, then pauses, resumes,
changes the level twice and stops:

```bash
WS=ws://localhost:8080/ws node controltest.js ABCD
```

---

## Multiple users (several rooms at once)

One deployment serves several people at the same time. Every controller opens its
own `/ws` connection, sends **its own room code**, and drives **its own bot** —
you can pause/level/stop only the sessions you created (HTTP-created sessions are
open to anyone).

* Capacity is `MAX_SESSIONS` (**default 3** — safe on Render's free 0.1-CPU
  instance; raise it with the env var on a bigger instance).
* Each room = one WebRTC peer + one 60 Hz input loop. When the server is full,
  `join` returns `{t:'error', message:'server full — N rooms max'}` and `GET /join`
  returns HTTP **429**.
* Sessions that ended are garbage-collected after 10 minutes, freeing slots.
* `/health` reports live usage: `{ "sessions": 3, "active": 3, "max": 8 }`.
* The dashboard header shows `n/8 rooms`.

> **Free plan note:** Render's free instance is 0.1 CPU / 512 MB. That comfortably
> holds **~2–3 rooms**; the Blueprint therefore defaults to `MAX_SESSIONS: 3`. For
> the full **8** concurrent rooms use a paid plan — `0.5c-512mb` (5× the free CPU)
> or `1c-2g` — and raise `MAX_SESSIONS`. A paid plan also removes the 15-minute
> idle sleep, so there are no cold starts.
>
> Rule of thumb per room: ~15–25 MB RAM and ~0.03 CPU (≈120 network packets/s).

Bumping the cap:

```yaml
# render.yaml
envVars:
  - key: MAX_SESSIONS
    value: "8"
```

---

## Deploy to Render (Singapore)

This repo ships a `render.yaml` blueprint already pinned to the **Singapore**
region (closest to India, keeps the WebRTC round-trip low).

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → pick the repo. Render reads `render.yaml`.
3. Deploy. Open the service URL, enter the room code, hit **JOIN ROOM**.

> Free plan note: the service sleeps after ~15 min idle and cold-starts in ~50 s.
> For zero cold-start use a paid instance.

---

## Self-test (no browser needed)

`selftest.js` stands up a fake host against the real server and validates the
whole pipeline (join → ICE → channels → lobby → start → 60 Hz inputs → ping/pong):

```bash
node selftest.js modi rahul          # runs host + bot together
FK_HOST_ONLY=1 node selftest.js      # prints a room code and waits
```

---

## Latency

The game is peer-to-peer over WebRTC, often via a **TURN relay** when both sides
are behind NAT. Distance dominates the round-trip: a US host vs an India host is
~260 ms minimum by physics. Run the bot in a region **close to the host**
(Render Singapore for India) for a fair fight.

---

## Layout

| file | role |
|---|---|
| `proto.js` | wire codecs (input bitmask, input packet, snapshot→fighter) |
| `ai.js` | CPU brain ported 1:1 from the game bundle + difficulty profiles |
| `moves.json` | move catalog extracted from the game |
| `net.js` | WebRTC guest client + signaling + ping/pong |
| `session.js` | one bot session (join → lobby → start → 60 Hz loop) |
| `index.js` | CLI entry point |
| `server.js` | HTTP service + WebSocket control channel + dashboard (Render entry) |
| `selftest.js` | fake-host harness for end-to-end testing |
| `controltest.js` | WebSocket control-channel test client |

MIT licensed. For educational / personal use.
