'use strict';
// fightkaro.com (Sansad Showdown) online bot — headless, pure Node.
// Joins a friend's room by its 4-char code and plays with the game's own CPU
// brain (hard profile) driven by live match snapshots, with lag prediction.
//
//   node index.js --code ABCD [--char modi] [--diff hard|extreme|ultimate] [--name neta]

const { startSession } = require('./session');

function parseArgs(argv) {
  const a = { char: 'modi', diff: 'hard', url: 'https://fightkaro.com', name: 'neta', duration: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    switch (k) {
      case '--code': case '-c': a.code = v; i++; break;
      case '--char': a.char = v; i++; break;
      case '--diff': case '-d': a.diff = v; i++; break;
      case '--name': a.name = v; i++; break;
      case '--url': a.url = v; i++; break;
      case '--duration': a.duration = Number(v) || 0; i++; break;
      case '--no-predict': a.predict = false; break;
      case '--help': case '-h': a.help = true; break;
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.code) {
  console.log(`Usage: node index.js --code <ROOM> [--char modi] [--diff easy|normal|hard|extreme|ultimate] [--name neta] [--url https://fightkaro.com] [--duration secs]`);
  process.exit(args.help ? 0 : 1);
}

const session = startSession({ ...args, log: (m) => console.log(m) });

process.on('SIGINT', () => { session.stop(); setTimeout(() => process.exit(0), 200); });
process.on('SIGTERM', () => { session.stop(); setTimeout(() => process.exit(0), 200); });
