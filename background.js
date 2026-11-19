'use strict';

// ---- Settings -------------------------------------------------------------
const ENGINE_FILE = 'engine/stockfish-19-lite-single.js'; // .wasm must sit next to it
const MOVE_TIME_MS = 2000; // search time per position; raise for stronger hints
const HASH_MB = 32;

// ---- State ----------------------------------------------------------------
let worker = null;
let ready = false;
let searching = false;
let current = null; // request being searched
let pending = null; // newest request waiting for the engine
let watchdog = null;

function send(cmd) {
  if (worker) worker.postMessage(cmd);
}

function reply(req, msg) {
  if (!req || !req.port) return;
  try {
    req.port.postMessage(Object.assign({ id: req.id }, msg));
  } catch (e) {
    /* port closed */
  }
}

function startEngine() {
  clearTimeout(watchdog);
  try {
    if (worker) worker.terminate();
  } catch (e) {}
  ready = false;
  searching = false;
  try {
    worker = new Worker(chrome.runtime.getURL(ENGINE_FILE));
  } catch (e) {
    reply(current, { type: 'error', message: 'Cannot start engine: ' + e.message });
    return;
  }
  worker.onmessage = (ev) => {
    const d = ev.data;
    const line = typeof d === 'string' ? d : d && typeof d.data === 'string' ? d.data : '';
    if (line) onLine(line);
  };
  worker.onerror = () => {
    ready = false;
    searching = false;
    reply(current || pending, {
      type: 'error',
      message: 'Engine files missing or blocked. See engine/README.txt',
    });
  };
  send('uci');
}

function onLine(line) {
  if (line === 'uciok') {
    send('setoption name Hash value ' + HASH_MB);
    send('isready');
    return;
  }
  if (line === 'readyok') {
    ready = true;
    if (pending && !searching) {
      const p = pending;
      pending = null;
      run(p);
    }
    return;
  }
  if (line.startsWith('info ') && line.includes(' pv ') && current) {
    if (/ (lowerbound|upperbound)/.test(line)) return;
    const depth = /\bdepth (\d+)/.exec(line);
    const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
    const pv = /\bpv (\S+)/.exec(line);
    if (depth && score && pv) {
      reply(current, {
        type: 'info',
        depth: +depth[1],
        scoreType: score[1],
        score: +score[2],
        move: pv[1],
      });
    }
    return;
  }
  if (line.startsWith('bestmove')) {
    clearTimeout(watchdog);
    searching = false;
    const done = current;
    const m = /^bestmove (\S+)/.exec(line);
    if (pending) {
      const p = pending;
      pending = null;
      run(p);
    } else if (done) {
      reply(done, { type: 'best', move: m ? m[1] : '(none)' });
    }
  }
}

function run(req) {
  current = req;
  searching = true;
  send('position fen ' + req.fen);
  send('go movetime ' + MOVE_TIME_MS);
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    // Engine hung or died (e.g. rejected a position): restart and retry once.
    if (searching && current === req) {
      pending = req;
      startEngine();
    }
  }, MOVE_TIME_MS + 6000);
}

function analyze(req) {
  if (!worker) startEngine();
  if (!ready) {
    pending = req;
    return;
  }
  if (searching) {
    pending = req;
    send('stop');
    return;
  }
  run(req);
}

chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'analyze' && typeof msg.fen === 'string') {
      analyze({ id: msg.id, fen: msg.fen, port });
    } else if (msg && msg.type === 'stop') {
      pending = null;
      if (searching) send('stop');
    }
  });
  port.onDisconnect.addListener(() => {
    if (pending && pending.port === port) pending = null;
  });
});

startEngine();
