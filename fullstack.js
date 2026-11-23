// Full-stack harness: REAL content.js + background.js + offscreen.js + chesslib.js + real Stockfish 19,
// wired through a mocked chrome runtime (ports + messages) and a fake Chess.com DOM.
const vm = require('vm'); const fs = require('fs'); const path = require('path');
const { makeRealWorkerClass, PROJ, cleanupRealWorkers } = require('./harness');

class FakeEl {
  constructor(tag, doc) {
    this.tag = tag; this.doc = doc; this.style = {}; this.children = []; this.attached = true;
    this.className = ''; this._text = ''; this.listeners = {}; this.attrs = {};
    const self = this;
    this.classList = { contains: (c) => (self.className || '').split(/\s+/).includes(c) };
    doc.created.push(this);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; if (v === '') this.children = []; }
  append(...els) { els.forEach((e) => this.children.push(e)); }
  appendChild(e) { this.children.push(e); e.attached = true; return e; }
  remove() { this.attached = false; }
  addEventListener(n, f) { this.listeners[n] = f; }
  closest() { return null; }
  getAttribute(n) { return this.attrs[n] === undefined ? null : this.attrs[n]; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  querySelectorAll(sel) { return this.doc.boardQuery(this, sel); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 800 }; }
}

function createStack(opts = {}) {
  const t0 = Date.now();
  const state = { pieces: [], highlights: [], bottomTurn: false, topTurn: false, flipped: false };
  const doc = {
    created: [], statusLog: [],
    documentElement: null,
    boardQuery(board, sel) {
      if (sel === '.piece') return state.pieces;
      if (sel === '.highlight') return state.highlights;
      return [];
    },
  };
  const board = new FakeEl('wc-chess-board', doc);
  board.classList = { contains: (c) => (c === 'flipped' ? state.flipped : false) };
  doc.documentElement = new FakeEl('html', doc);
  doc.documentElement.contains = (e) => e.attached !== false;
  doc.querySelector = (sel) => {
    if (sel === 'wc-chess-board, chess-board') return board;
    if (sel.startsWith('.clock-bottom')) return state.bottomTurn ? new FakeEl('div', doc) : null;
    if (sel.startsWith('.clock-top')) return state.topTurn ? new FakeEl('div', doc) : null;
    return null; // no [data-ply], no page FEN
  };
  doc.querySelectorAll = (sel) => (sel === '.sfx-overlay' ? board.children.filter((c) => c.className === 'sfx-overlay') : []);
  doc.createElement = (tag) => new FakeEl(tag, doc);

  // ---- chrome bus ----
  const ctxs = []; const connectListeners = [];
  function mkChrome(name) {
    const listeners = [];
    const ch = {
      _listeners: listeners,
      runtime: {
        getURL: (p) => p,
        onMessage: { addListener: (h) => listeners.push(h) },
        sendMessage: (msg) => {
          const m = JSON.parse(JSON.stringify(msg));
          setTimeout(() => { for (const c of ctxs) if (c !== ch) c._listeners.forEach((h) => h(m, {})); }, 0);
          return Promise.resolve();
        },
        onConnect: { addListener: (h) => connectListeners.push(h) },
        onStartup: { addListener() {} }, onInstalled: { addListener() {} },
        connect: ({ name: pn }) => {
          const mk = () => ({ ml: [], dl: [], onMessage: { addListener(f) { this._p.ml.push(f); } }, onDisconnect: { addListener(f) { this._p.dl.push(f); } } });
          const a = mk(), b = mk();
          a.onMessage = { addListener: (f) => a.ml.push(f) }; a.onDisconnect = { addListener: (f) => a.dl.push(f) };
          b.onMessage = { addListener: (f) => b.ml.push(f) }; b.onDisconnect = { addListener: (f) => b.dl.push(f) };
          a.name = b.name = pn;
          a.postMessage = (m) => { const c = JSON.parse(JSON.stringify(m)); setTimeout(() => b.ml.forEach((f) => f(c)), 0); };
          b.postMessage = (m) => { const c = JSON.parse(JSON.stringify(m)); setTimeout(() => a.ml.forEach((f) => f(c)), 0); };
          a.disconnect = () => { b.dl.forEach((f) => f()); };
          setTimeout(() => connectListeners.forEach((f) => f(b)), 0);
          return a;
        },
      },
      storage: { local: { get: (k, cb) => cb({ sfx: opts.settings || {} }), set() {} } },
    };
    ctxs.push(ch);
    return ch;
  }
  const out = { log: { cmds: [], violations: [], workers: 0, terminated: 0, goCount: 0, children: [] }, state, doc, board, t0 };

  // background context
  const bgChrome = mkChrome('bg'); let offscreenUp = false;
  bgChrome.offscreen = {
    Reason: { WORKERS: 'WORKERS' },
    hasDocument: async () => offscreenUp,
    createDocument: async () => {
      offscreenUp = true;
      const oc = mkChrome('off');
      const sb = { console, setTimeout, clearTimeout, Date, Math, JSON, Promise, chrome: oc };
      sb.self = sb; vm.createContext(sb);
      vm.runInContext(fs.readFileSync(path.join(PROJ, 'chesslib.js'), 'utf8'), sb);
      sb.Worker = makeRealWorkerClass(out.log);
      vm.runInContext(fs.readFileSync(path.join(PROJ, 'offscreen.js'), 'utf8'), sb);
      out.offscreenCtx = sb;
    },
  };
  const bg = { console, setTimeout, clearTimeout, Date, Math, JSON, Promise, chrome: bgChrome };
  bg.self = bg; vm.createContext(bg);
  vm.runInContext(fs.readFileSync(path.join(PROJ, 'background.js'), 'utf8'), bg, { filename: 'background.js' });

  // content-script context
  const cChrome = mkChrome('content');
  const book = fs.readFileSync(path.join(PROJ, 'openings.json'), 'utf8');
  const cs = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, Number, Array, Object, Set, String, RegExp,
    document: doc, location: { hostname: 'www.chess.com', pathname: '/game/live/123456' }, chrome: cChrome,
    fetch: async () => ({ ok: true, json: async () => JSON.parse(book) }),
  };
  cs.self = cs; cs.window = cs; vm.createContext(cs);
  vm.runInContext(fs.readFileSync(path.join(PROJ, 'chesslib.js'), 'utf8'), cs, { filename: 'chesslib.js' });
  out.chess = cs.SF19Chess;
  // status logger: hook textContent writes on elements whose text starts with SF19
  vm.runInContext(fs.readFileSync(path.join(PROJ, 'content.js'), 'utf8'), cs, { filename: 'content.js' });

  out.cleanup = () => cleanupRealWorkers(out.log);
  out.status = () => { const e = doc.created.find((x) => x.tag === 'span' && /^SF19 /.test(x._text)); return e ? e._text : ''; };
  out.opening = () => { const e = doc.created.filter((x) => x.tag === 'span' && !/^SF19 /.test(x._text) && x.attached)[0]; return e ? e._text : ''; };
  out.overlaySquares = () => { const ov = doc.created.find((c) => c.className === 'sfx-overlay' && c.attached); return ov ? ov.children.length : 0; };
  // Fake DOM updates
  out.setPosition = (fen, lastMove, opts2 = {}) => {
    const C = out.chess; const pos = C.parseFen(fen);
    state.pieces = []; state.highlights = [];
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const pc = pos.g[r][f]; if (!pc) continue;
      const el = new FakeEl('div', doc);
      el.className = `piece ${pc === pc.toUpperCase() ? 'w' : 'b'}${pc.toLowerCase()} square-${f + 1}${r + 1}`;
      state.pieces.push(el);
    }
    if (lastMove) for (const sq of [lastMove.slice(0, 2), lastMove.slice(2, 4)]) {
      const el = new FakeEl('div', doc); el.className = `highlight square-${sq.charCodeAt(0) - 96}${sq[1]}`; state.highlights.push(el);
    }
    state.flipped = !!opts2.flipped;
    const myTurnBottom = opts2.bottomTurn !== undefined ? opts2.bottomTurn : true;
    state.bottomTurn = myTurnBottom; state.topTurn = !myTurnBottom;
    out.setAt = Date.now();
  };
  return out;
}
module.exports = { createStack };
