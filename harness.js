// Loads the REAL offscreen.js + chesslib.js in a vm sandbox with a mocked chrome
// runtime and either a scripted fake engine or the real Stockfish 19 (child process).
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const PROJ = path.join(__dirname, '..');
const liveEngineProcesses = new Set();
function cleanupRealWorkers(log) {
  const children = log && Array.isArray(log.children) ? log.children : Array.from(liveEngineProcesses);
  for (const child of children) {
    liveEngineProcesses.delete(child);
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}
process.on('exit', () => cleanupRealWorkers());

function makeFakeWorkerClass(log, opts) {
  const SPEED = opts.speed || 50;
  return class FakeWorker {
    constructor() {
      this.searching = false; this.timer = null; this.fen = null; this.multipv = 1; this.dead = false;
      log.workers++;
      setTimeout(() => {}, 0);
    }
    _emit(line) { if (!this.dead && this.onmessage) setTimeout(() => !this.dead && this.onmessage({ data: line }), 0); }
    postMessage(cmd) {
      const C = opts.chess;
      log.cmds.push(cmd);
      if (cmd === 'uci') this._emit('uciok');
      else if (cmd === 'isready') this._emit('readyok');
      else if (cmd.startsWith('setoption name MultiPV value ')) this.multipv = +cmd.split(' ').pop();
      else if (cmd.startsWith('position ')) {
        this.positionCmd = cmd;
        let fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        if (cmd.startsWith('position fen ')) {
          const rest = cmd.slice('position fen '.length);
          const idx = rest.indexOf(' moves ');
          fen = idx < 0 ? rest : rest.slice(0, idx);
          const moves = idx < 0 ? [] : rest.slice(idx + 7).trim().split(/\s+/).filter(Boolean);
          for (const mv of moves) fen = C.applyUci(fen, mv) || fen;
        } else if (cmd.startsWith('position startpos moves ')) {
          const moves = cmd.slice('position startpos moves '.length).trim().split(/\s+/).filter(Boolean);
          for (const mv of moves) fen = C.applyUci(fen, mv) || fen;
        }
        this.fen = fen;
      }
      else if (cmd.startsWith('go movetime ')) {
        if (this.searching) { log.violations.push('go while searching: ' + cmd); return; }
        this.searching = true;
        const mt = +cmd.split(' ').pop();
        const fen = this.fen, mpv = this.multipv;
        log.searches.push({ fen, mpv, mt, positionCmd: this.positionCmd });
        const pos = C.parseFen(fen);
        const moves = pos ? C.legalMoves(pos).map((m) => m.uci).sort() : [];
        const finish = () => {
          this.searching = false;
          const n = Math.min(mpv, moves.length);
          for (let i = 0; i < n; i++) {
            this._emit(`info depth 12 seldepth 14 multipv ${i + 1} score cp ${50 - i * 10} nodes 1000 nps 1000 time 10 pv ${moves[i]}`);
          }
          this._emit('bestmove ' + (moves[0] || '(none)'));
        };
        this.finish = finish;
        this.timer = setTimeout(finish, Math.max(5, mt / SPEED));
      } else if (cmd === 'stop') {
        if (this.searching) { clearTimeout(this.timer); log.stops++; this.searching = false; this._emit('bestmove ' + 'stopped_dummy'); }
      }
    }
    terminate() { this.dead = true; clearTimeout(this.timer); log.terminated++; }
  };
}

function makeRealWorkerClass(log) {
  return class RealWorker {
    constructor() {
      log.workers++;
      this.buf = '';
      this.p = spawn('node', [path.join(PROJ, 'engine', 'stockfish-19-lite-single.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
      liveEngineProcesses.add(this.p);
      log.children.push(this.p);
      this.p.on('exit', () => liveEngineProcesses.delete(this.p));
      this.p.stdout.on('data', (d) => {
        this.buf += d.toString();
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1);
          if (line.startsWith('bestmove')) log.outstanding = Math.max(0, (log.outstanding || 0) - 1);
          if (line && this.onmessage) this.onmessage({ data: line });
        }
      });
      this.p.stderr.on('data', () => {});
    }
    postMessage(cmd) {
      log.cmds.push(cmd);
      if (cmd.startsWith('go ')) {
        if ((log.outstanding || 0) > 0) log.violations.push('go while a search is outstanding');
        log.outstanding = (log.outstanding || 0) + 1; log.goCount++;
      }
      if (cmd.startsWith('position ')) log.lastPos = cmd;
      try { this.p.stdin.write(cmd + '\n'); } catch (e) {}
    }
    terminate() { log.terminated++; liveEngineProcesses.delete(this.p); try { this.p.kill('SIGKILL'); } catch (e) {} }
  };
}

function createOffscreen(opts = {}) {
  const log = { cmds: [], searches: [], violations: [], stops: 0, workers: 0, terminated: 0, goCount: 0, children: [] };
  const handlers = [];
  const replies = [];
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    chrome: {
      runtime: {
        getURL: (p) => p,
        sendMessage: (m) => { if (m && m.target === 'background') replies.push(Object.assign({ t: Date.now() }, m)); return Promise.resolve(); },
        onMessage: { addListener: (h) => handlers.push(h) },
      },
    },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PROJ, 'chesslib.js'), 'utf8'), sandbox, { filename: 'chesslib.js' });
  const chess = sandbox.SF19Chess;
  sandbox.Worker = opts.real ? makeRealWorkerClass(log) : makeFakeWorkerClass(log, { speed: opts.speed, chess });
  vm.runInContext(fs.readFileSync(path.join(PROJ, opts.file || 'offscreen.js'), 'utf8'), sandbox, { filename: 'offscreen.js' });
  const send = (msg) => handlers.forEach((h) => h(Object.assign({ target: 'offscreen' }, msg)));
  return { send, replies, log, chess, sandbox, cleanup: () => cleanupRealWorkers(log) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout = 5000, step = 5) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (cond()) return true; await sleep(step); }
  return false;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail !== undefined ? '| ' + JSON.stringify(detail) : ''); }
}
function summary() { console.log(`\n${pass} passed, ${fail} failed`); return fail; }

module.exports = { makeRealWorkerClass, PROJ, createOffscreen, sleep, waitFor, check, summary, cleanupRealWorkers };
