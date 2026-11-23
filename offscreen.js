'use strict';

// Stockfish lives in the offscreen document (MV3).
//
// Jobs sent to the single engine worker:
//   main   - analysis of the position the user must move in (high priority)
//   ponder - background analysis while the opponent is thinking (low priority,
//            always preempted by a main request, never blocks it)
//
// Results are cached by normalized position key (placement + side to move +
// effective castling + capturable en-passant). Every reply carries that key so
// the content script can reject anything that belongs to another position.

const ENGINE_FILE = 'engine/stockfish-19-lite-single.js';
const MOVE_TIME_MS = 6500;
const HASH_MB = 128;
const MAIN_MULTIPV = 1; // only one BEST MOVE is displayed
const WATCHDOG_EXTRA_MS = 15000;
const MAX_RESTARTS = 5;

// Ponder a broader set of plausible opponent replies while the opponent thinks.
const PONDER_ROOT_MS = 1300;
const PONDER_CHILD_MS = 3200;
const PONDER_MAX_MOVES = 5;
const PONDER_WINDOW_CP = 250;
const CACHE_MAX = 128;

const SF = (typeof self !== 'undefined' && self.SF19Chess) || null;

let worker = null;
let ready = false;
let searching = false; // true from `go` until the matching `bestmove` arrives
let current = null; // job currently inside the engine
let pending = null; // newest main request waiting for the engine
let ponderPlan = null; // background plan (at most one)
let watchdog = null;
let multipvLines = {}; // working lines for the newest depth
let multipvDepthFloor = 0;
let multipvCompleteLines = {}; // last depth with a complete MultiPV set
let multipvCompleteDepth = 0;
let engineMultipv = 0;
let mateCandidate = null;
let mateCandidateDepth = 0;
let mateCandidateScore = null;
let mateStableDepths = 0;
let mateStopSent = false;
let restartCount = 0;
let restartTimer = null;

const analysisCache = new Map(); // key -> {move, lines, depth, source, quality}
const lastIdByPort = new Map(); // sourcePortId -> highest request id seen

function reply(req, msg) {
  if (!req || !req.sourcePortId) return;
  chrome.runtime.sendMessage({
    target: 'background',
    sourcePortId: req.sourcePortId,
    id: req.id,
    ...msg,
  }).catch(() => {});
}

function send(cmd) {
  if (worker) worker.postMessage(cmd);
}

// Who (if anyone) is waiting for the result of a job.
function jobTarget(job) {
  if (!job) return null;
  return job.promoted || (job.kind === 'main' ? job.req : null);
}

// ----------------------------------------------------------------------
// Cache
// ----------------------------------------------------------------------
function cacheGet(key) {
  const e = analysisCache.get(key);
  if (!e) return null;
  analysisCache.delete(key);
  analysisCache.set(key, e); // refresh LRU order
  return e;
}

function cachePut(key, entry) {
  if (!key || !entry || !entry.move) return;
  const old = analysisCache.get(key);
  if (old && old.quality >= entry.quality) {
    analysisCache.delete(key);
    analysisCache.set(key, old);
    return;
  }
  analysisCache.delete(key);
  analysisCache.set(key, entry);
  while (analysisCache.size > CACHE_MAX) {
    analysisCache.delete(analysisCache.keys().next().value);
  }
}

function safePositionCommand(fen, supplied) {
  if (typeof supplied !== 'string') return 'position fen ' + fen;
  const cmd = supplied.trim();
  const moveList = String.raw`(?:[a-h][1-8][a-h][1-8][qrbn]?)(?:\s+[a-h][1-8][a-h][1-8][qrbn]?)*`;
  if (/^position startpos$/.test(cmd)) return cmd;
  if (new RegExp('^position startpos moves ' + moveList + '$').test(cmd)) return cmd;
  const fenPattern = String.raw`position fen [rnbqkpRNBQKP1-8/]+ [wb] (?:-|K?Q?k?q?) (?:-|[a-h][36]) \d+ [1-9]\d*`;
  if (new RegExp('^' + fenPattern + '$').test(cmd)) return cmd;
  if (new RegExp('^' + fenPattern + ' moves ' + moveList + '$').test(cmd)) return cmd;
  return 'position fen ' + fen;
}

function cacheKeyFor(fen, positionCmd) {
  const base = SF ? SF.positionKey(fen) : fen;
  if (!base) return null;
  const m = /\bmoves\s+(.+)$/.exec(positionCmd || '');
  if (!m) return base;
  const root = positionCmd.slice(0, positionCmd.indexOf(' moves '));
  return base + '\u241f' + root + ' ' + m[1];
}

function appendPositionMove(positionCmd, uci) {
  if (!positionCmd || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci || '')) return null;
  return positionCmd + (positionCmd.includes(' moves ') ? ' ' : ' moves ') + uci;
}

// Make sure the first line is the move the engine actually returned.
function normalizeLines(best, lines) {
  if (lines[0] && lines[0].move === best) return lines;
  const idx = lines.findIndex((L) => L.move === best);
  if (idx > 0) return [lines[idx]].concat(lines.filter((_, i) => i !== idx));
  return [{ move: best, depth: lines[0] ? lines[0].depth : 0 }];
}

// ----------------------------------------------------------------------
// Engine lifecycle
// ----------------------------------------------------------------------
function startEngine() {
  clearTimeout(watchdog);
  clearTimeout(restartTimer);
  try {
    if (worker) worker.terminate();
  } catch (e) {}
  worker = null;
  ready = false;
  searching = false;
  current = null;
  engineMultipv = 0;
  multipvLines = {};
  multipvDepthFloor = 0;
  multipvCompleteLines = {};
  multipvCompleteDepth = 0;
  mateCandidate = null;
  mateCandidateDepth = 0;
  mateCandidateScore = null;
  mateStableDepths = 0;
  mateStopSent = false;

  try {
    worker = new Worker(chrome.runtime.getURL(ENGINE_FILE));
  } catch (e) {
    reply(jobTarget(current) || pending, {
      type: 'error',
      message: 'Cannot start engine: ' + e.message,
    });
    return;
  }

  worker.onmessage = (ev) => {
    const d = ev.data;
    const line = typeof d === 'string' ? d : (d && typeof d.data === 'string' ? d.data : '');
    if (line) onLine(line);
  };

  worker.onerror = () => {
    ready = false;
    searching = false;
    reply(jobTarget(current) || pending, {
      type: 'error',
      message: 'Engine error / files missing. Check engine/ folder.',
    });
    ponderPlan = null;
    current = null;
    scheduleRestart();
  };

  send('uci');
}

function scheduleRestart() {
  if (restartCount >= MAX_RESTARTS) {
    reply(jobTarget(current) || pending, {
      type: 'error',
      message: 'Engine failed repeatedly; reload the extension.',
    });
    return;
  }
  restartCount++;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => startEngine(), 1500 + restartCount * 500);
}

function collectLines() {
  const required = current && current.multipv ? current.multipv : 1;
  const workingIndexes = Object.keys(multipvLines).map(Number);
  const completeWorking = workingIndexes.length >= required &&
    Array.from({ length: required }, (_, i) => i + 1).every((idx) => !!multipvLines[idx]);
  const source = completeWorking ? multipvLines : multipvCompleteLines;
  return Object.keys(source).map(Number).sort((a, b) => a - b).map((k) => source[k]);
}

function rememberCompleteMultiPv() {
  if (!current) return;
  const required = current.multipv || 1;
  const complete = Array.from({ length: required }, (_, i) => i + 1)
    .every((idx) => !!multipvLines[idx]);
  if (complete) {
    multipvCompleteLines = Object.assign({}, multipvLines);
    multipvCompleteDepth = multipvDepthFloor;
  }
}

function onLine(line) {
  if (line === 'uciok') {
    send('setoption name Hash value ' + HASH_MB);
    send('setoption name Threads value 1');
    send('setoption name MultiPV value ' + MAIN_MULTIPV);
    engineMultipv = MAIN_MULTIPV;
    send('isready');
    return;
  }

  if (line === 'readyok') {
    ready = true;
    restartCount = 0; // successful boot
    pump();
    return;
  }

  if (line.startsWith('info ') && line.includes(' pv ') && current && !current.cancelled) {
    if (/ (lowerbound|upperbound)/.test(line)) return;
    const depth = /\bdepth (\d+)/.exec(line);
    const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
    const pv = /\bpv (\S+)/.exec(line);
    const mpv = /\bmultipv (\d+)/.exec(line);
    if (!depth || !score || !pv) return;

    const d = +depth[1];
    const idx = mpv ? +mpv[1] : 1;

    // Drop stale shallower multipv entries when a new deeper iteration starts
    if (d > multipvDepthFloor) {
      multipvDepthFloor = d;
      multipvLines = {};
    }
    // Ignore info from an older depth still in flight
    if (d < multipvDepthFloor) return;

    multipvLines[idx] = {
      depth: d,
      scoreType: score[1],
      score: +score[2],
      move: pv[1],
    };
    rememberCompleteMultiPv();

    const target = jobTarget(current);
    const currentTop = multipvLines[1];
    if (currentTop && currentTop.scoreType === 'mate' && currentTop.score !== 0) {
      const nextDepth = currentTop.depth > mateCandidateDepth;
      if (mateCandidate === currentTop.move && mateCandidateScore === currentTop.score && nextDepth) {
        mateStableDepths++;
      } else if (nextDepth || mateCandidate !== currentTop.move || mateCandidateScore !== currentTop.score) {
        mateStableDepths = 1;
      }
      mateCandidate = currentTop.move;
      mateCandidateScore = currentTop.score;
      mateCandidateDepth = currentTop.depth;
      // Stop on an immediate forced mate, or after the same mate score and
      // best move survive successive deeper iterations. Negative mate scores
      // are handled too, but are never treated as a mate-in-one win.
      if (!mateStopSent && ((currentTop.score > 0 && currentTop.score === 1) || mateStableDepths >= 2)) {
        mateStopSent = true;
        send('stop');
      }
    } else if (currentTop && currentTop.depth > mateCandidateDepth) {
      mateCandidate = null;
      mateCandidateScore = null;
      mateCandidateDepth = currentTop.depth;
      mateStableDepths = 0;
    }
    if (target) {
      reply(target, {
        type: 'info',
        depth: multipvDepthFloor,
        lines: collectLines(),
        id: target.id,
        key: current.key || null,
      });
    }
    return;
  }

  if (line.startsWith('bestmove')) {
    clearTimeout(watchdog);
    searching = false;
    const done = current;
    const m = /^bestmove (\S+)/.exec(line);
    const lines = collectLines();
    multipvLines = {};
    multipvDepthFloor = 0;
    current = null;
    finishJob(done, m ? m[1] : null, lines);
    pump();
  }
}

// ----------------------------------------------------------------------
// Job completion
// ----------------------------------------------------------------------
function finishJob(done, best, lines) {
  if (!done || done.cancelled) return; // obsolete: never cached, never shown
  const hasMove = !!best && best !== '(none)' && best !== '0000';

  if (done.kind === 'ponder' && !done.promoted) {
    const plan = done.plan;
    if (!plan || plan !== ponderPlan) return;
    if (done.stage === 'root') {
      onPonderRoot(plan, lines);
      return;
    }
    if (hasMove) {
      const nl = normalizeLines(best, lines);
      cachePut(done.cacheKey || done.key, {
        move: best, lines: nl, depth: nl[0] ? nl[0].depth || 0 : 0,
        source: 'ponder', quality: done.movetime,
      });
    }
    plan.done++;
    ponderStatus(plan);
    return;
  }

  const target = done.promoted || done.req;
  let outLines = lines;
  if (hasMove) {
    outLines = normalizeLines(best, lines);
    if (done.key) {
      cachePut(done.cacheKey || done.key, {
        move: best, lines: outLines, depth: outLines[0] ? outLines[0].depth || 0 : 0,
        source: done.kind === 'ponder' ? 'ponder' : 'main', quality: done.movetime,
      });
    }
  }
  reply(target, {
    type: 'best',
    move: best || (lines[0] && lines[0].move) || '(none)',
    lines: outLines,
    id: target.id,
    key: done.key || null,
  });
}

// ----------------------------------------------------------------------
// Ponder (background analysis of the opponent's likely replies)
// ----------------------------------------------------------------------
function scoreToCp(L) {
  if (L.scoreType === 'mate') return L.score > 0 ? 100000 - L.score : -100000 - L.score;
  return typeof L.score === 'number' ? L.score : 0;
}

function ponderStatus(plan) {
  reply({ id: plan.id, sourcePortId: plan.sourcePortId }, {
    type: 'ponder-status',
    id: plan.id,
    key: plan.rootKey,
    done: plan.done,
    total: plan.total,
  });
}

function onPonderRoot(plan, lines) {
  plan.stage = 'children';
  if (!lines.length) { ponderPlan = null; return; }
  const bestCp = scoreToCp(lines[0]);
  const included = [];
  for (const L of lines) {
    if (included.length >= PONDER_MAX_MOVES) break;
    if (bestCp - scoreToCp(L) > PONDER_WINDOW_CP) continue;
    const fen = SF.applyUci(plan.rootFen, L.move);
    if (!fen || !SF.hasLegalMoves(fen)) continue;
    const key = SF.positionKey(fen);
    const positionCmd = appendPositionMove(plan.positionCmd, L.move);
    const cacheKey = cacheKeyFor(fen, positionCmd);
    if (!key || !positionCmd || !cacheKey) continue;
    included.push({ fen, key, cacheKey, positionCmd, move: L.move });
  }
  plan.children = included.filter((c) => !analysisCache.has(c.cacheKey));
  plan.total = included.length;
  plan.done = included.length - plan.children.length;
  ponderStatus(plan);
}

function nextPonderJob() {
  const plan = ponderPlan;
  if (!plan) return null;
  const req = { id: plan.id, sourcePortId: plan.sourcePortId };
  if (plan.stage === 'root') {
    return {
      kind: 'ponder', stage: 'root', plan, req, key: plan.rootKey,
      cacheKey: cacheKeyFor(plan.rootFen, plan.positionCmd), fen: plan.rootFen,
      positionCmd: plan.positionCmd, movetime: PONDER_ROOT_MS, multipv: PONDER_MAX_MOVES,
    };
  }
  while (plan.next < plan.children.length) {
    const c = plan.children[plan.next++];
    if (analysisCache.has(c.cacheKey)) { plan.done++; continue; }
    return {
      kind: 'ponder', stage: 'child', plan, req, key: c.key, cacheKey: c.cacheKey,
      fen: c.fen, positionCmd: c.positionCmd,
      movetime: PONDER_CHILD_MS, multipv: 1,
    };
  }
  ponderPlan = null;
  return null;
}

// ----------------------------------------------------------------------
// Scheduling
// ----------------------------------------------------------------------
function mainJob(req) {
  return {
    kind: 'main', req, key: req.key || null, cacheKey: req.cacheKey || req.key || null,
    fen: req.fen, positionCmd: req.positionCmd || ('position fen ' + req.fen),
    movetime: MOVE_TIME_MS, multipv: MAIN_MULTIPV,
  };
}

// Engine is free: main requests always go first, ponder only when nothing waits.
function pump() {
  if (!ready || searching) return;
  if (pending) {
    const p = pending;
    pending = null;
    run(mainJob(p));
    return;
  }
  const job = nextPonderJob();
  if (job) run(job);
}

function run(job) {
  current = job;
  searching = true;
  multipvLines = {};
  multipvDepthFloor = 0;
  multipvCompleteLines = {};
  multipvCompleteDepth = 0;
  mateCandidate = null;
  mateCandidateDepth = 0;
  mateCandidateScore = null;
  mateStableDepths = 0;
  mateStopSent = false;
  if (engineMultipv !== job.multipv) {
    send('setoption name MultiPV value ' + job.multipv);
    engineMultipv = job.multipv;
  }
  send(job.positionCmd || ('position fen ' + job.fen));
  send('go movetime ' + job.movetime);

  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (searching && current === job) {
      const target = jobTarget(job);
      if (!job.cancelled && target) pending = target;
      if (job.kind === 'ponder') ponderPlan = null;
      current = null;
      searching = false;
      scheduleRestart();
    }
  }, job.movetime + WATCHDOG_EXTRA_MS);
}

function cancelCurrent() {
  if (!current) return;
  current.cancelled = true;
  multipvLines = {};
  multipvDepthFloor = 0;
  if (searching) send('stop');
}

// Cancel obsolete work that belongs to one content-script port.
// keepPonder: a plain `stop` (position changed) leaves the ponder plan alone,
// because the new position may be exactly the reply being pondered.
function cancelForPort(portId, keepPonder) {
  if (pending && pending.sourcePortId === portId) pending = null;
  if (!keepPonder && ponderPlan && ponderPlan.sourcePortId === portId) ponderPlan = null;
  if (current && !current.cancelled && current.req.sourcePortId === portId) {
    if (keepPonder && current.kind === 'ponder' && !current.promoted) return;
    cancelCurrent();
  }
}

function acceptId(msg) {
  if (typeof msg.id !== 'number') return true;
  const last = lastIdByPort.get(msg.sourcePortId);
  if (last !== undefined && msg.id < last) return false; // out-of-order, obsolete
  lastIdByPort.set(msg.sourcePortId, msg.id);
  return true;
}

function analyze(req) {
  if (!worker) startEngine();
  req.key = SF ? SF.positionKey(req.fen) : null;
  req.positionCmd = safePositionCommand(req.fen, req.positionCmd);
  req.cacheKey = cacheKeyFor(req.fen, req.positionCmd);

  // 1) Already analysed with the same move history (typically pondered while
  // the opponent was thinking). Repetition-sensitive histories never collide.
  const hit = req.cacheKey ? cacheGet(req.cacheKey) : null;
  if (hit) {
    cancelForPort(req.sourcePortId); // anything still running for this port is obsolete
    reply(req, {
      type: 'best', move: hit.move, lines: hit.lines, id: req.id,
      key: req.key, cached: true, source: hit.source,
    });
    return;
  }

  // 2) The engine is already searching exactly this position as a ponder job:
  //    let it finish and answer from it instead of restarting from scratch.
  const c = current;
  if (c && !c.cancelled && c.kind === 'ponder' && c.stage === 'child' && !c.promoted &&
      c.cacheKey && c.cacheKey === req.cacheKey && c.req.sourcePortId === req.sourcePortId) {
    if (pending && pending.sourcePortId === req.sourcePortId) pending = null;
    c.promoted = req;
    if (ponderPlan && ponderPlan.sourcePortId === req.sourcePortId) ponderPlan = null;
    return;
  }

  // 3) Unexpected position: fresh analysis, preempting any background work
  cancelForPort(req.sourcePortId);
  if (!ready) {
    pending = req;
    return;
  }
  if (searching) {
    // Newer position wins - never let old lines reach the UI
    pending = req;
    if (current && !current.cancelled) cancelCurrent();
    return;
  }
  run(mainJob(req));
}

function ponder(req) {
  if (!SF) return;
  const key = SF.positionKey(req.fen);
  if (!key) return;
  const positionCmd = safePositionCommand(req.fen, req.positionCmd);
  cancelForPort(req.sourcePortId);
  ponderPlan = {
    sourcePortId: req.sourcePortId, id: req.id, rootFen: req.fen, rootKey: key,
    positionCmd, stage: 'root', children: [], next: 0, total: 0, done: 0,
  };
  pump();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'analyze' && typeof msg.fen === 'string') {
    if (!acceptId(msg)) return;
    analyze({ id: msg.id, fen: msg.fen, positionCmd: msg.positionCmd, sourcePortId: msg.sourcePortId });
  } else if (msg.type === 'ponder' && typeof msg.fen === 'string') {
    if (!acceptId(msg)) return;
    ponder({ id: msg.id, fen: msg.fen, positionCmd: msg.positionCmd, sourcePortId: msg.sourcePortId });
  } else if (msg.type === 'stop') {
    cancelForPort(msg.sourcePortId, true);
  } else if (msg.type === 'stop-all') {
    cancelForPort(msg.sourcePortId, false);
  } else if (msg.type === 'port-closed') {
    cancelForPort(msg.sourcePortId, false);
    lastIdByPort.delete(msg.sourcePortId);
  }
});

startEngine();
