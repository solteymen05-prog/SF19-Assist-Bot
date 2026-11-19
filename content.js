(() => {
  'use strict';

  const POLL_MS = 300;
  const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  const RED = 'rgba(255, 0, 0, 0.6)';

  // ======================================================================
  // Pure chess helpers (no DOM) - grid[rank0][file0], rank0 = 0 is rank 1.
  // Uppercase = white, lowercase = black.
  // ======================================================================
  const inb = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;
  const colorOf = (pc) => (pc === pc.toUpperCase() ? 'w' : 'b');

  function attacked(g, r, f, by) {
    const isBy = (pc, types) => !!pc && colorOf(pc) === by && types.includes(pc.toLowerCase());
    const pr = by === 'w' ? r - 1 : r + 1;
    for (const df of [-1, 1]) {
      if (inb(pr, f + df) && isBy(g[pr][f + df], ['p'])) return true;
    }
    const kn = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
    for (const [dr, df] of kn) {
      if (inb(r + dr, f + df) && isBy(g[r + dr][f + df], ['n'])) return true;
    }
    for (let dr = -1; dr <= 1; dr++) {
      for (let df = -1; df <= 1; df++) {
        if ((dr || df) && inb(r + dr, f + df) && isBy(g[r + dr][f + df], ['k'])) return true;
      }
    }
    const slide = (dirs, types) => {
      for (const [dr, df] of dirs) {
        let rr = r + dr;
        let ff = f + df;
        while (inb(rr, ff)) {
          const pc = g[rr][ff];
          if (pc) {
            if (isBy(pc, types)) return true;
            break;
          }
          rr += dr;
          ff += df;
        }
      }
      return false;
    };
    return (
      slide([[1, 1], [1, -1], [-1, 1], [-1, -1]], ['b', 'q']) ||
      slide([[1, 0], [-1, 0], [0, 1], [0, -1]], ['r', 'q'])
    );
  }

  function findKing(g, color) {
    const k = color === 'w' ? 'K' : 'k';
    let found = null;
    let count = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (g[r][f] === k) {
          found = [r, f];
          count++;
        }
      }
    }
    return count === 1 ? found : null;
  }

  // A position is plausible if both kings exist and the side NOT to move is not in check.
  function plausible(g, turn) {
    const wk = findKing(g, 'w');
    const bk = findKing(g, 'b');
    if (!wk || !bk) return false;
    const other = turn === 'w' ? 'b' : 'w';
    const ok = other === 'w' ? wk : bk;
    return !attacked(g, ok[0], ok[1], turn);
  }

  function placementOf(g) {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let s = '';
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const pc = g[r][f];
        if (!pc) {
          empty++;
        } else {
          if (empty) s += empty;
          empty = 0;
          s += pc;
        }
      }
      if (empty) s += empty;
      rows.push(s);
    }
    return rows.join('/');
  }

  function epSquare(g, hl, turn) {
    if (hl.length < 2) return '-';
    const mover = turn === 'w' ? 'b' : 'w';
    const pawn = mover === 'w' ? 'P' : 'p';
    const startRank = mover === 'w' ? 1 : 6;
    const endRank = mover === 'w' ? 3 : 4;
    const enemyPawn = turn === 'w' ? 'P' : 'p';
    for (const to of hl) {
      if (g[to.r][to.f] !== pawn || to.r !== endRank) continue;
      const from = hl.find((h) => h.f === to.f && h.r === startRank && !g[h.r][h.f]);
      if (!from) continue;
      const adj = [to.f - 1, to.f + 1].some((ff) => inb(to.r, ff) && g[to.r][ff] === enemyPawn);
      if (!adj) return '-';
      const midRank = (startRank + endRank) / 2;
      return String.fromCharCode(97 + to.f) + (midRank + 1);
    }
    return '-';
  }

  function castlingString(rights) {
    const s = (rights.K ? 'K' : '') + (rights.Q ? 'Q' : '') + (rights.k ? 'k' : '') + (rights.q ? 'q' : '');
    return s || '-';
  }

  function updateRights(rights, g) {
    if (g[0][4] !== 'K') rights.K = rights.Q = false;
    if (g[0][7] !== 'R') rights.K = false;
    if (g[0][0] !== 'R') rights.Q = false;
    if (g[7][4] !== 'k') rights.k = rights.q = false;
    if (g[7][7] !== 'r') rights.k = false;
    if (g[7][0] !== 'r') rights.q = false;
  }

  function buildFen(g, turn, rights, hl) {
    return [placementOf(g), turn, castlingString(rights), epSquare(g, hl, turn), '0', '1'].join(' ');
  }

  // Work out whose move it is. Returns an ordered list of candidate turns
  // (most likely first); the caller picks the first that gives a plausible position.
  function turnCandidates(g, hl, plies, myColor) {
    let primary;
    if (plies !== null) {
      primary = plies % 2 === 0 ? 'w' : 'b';
    } else {
      const oppColor = myColor === 'w' ? 'b' : 'w';
      const occupied = hl.filter((h) => g[h.r][h.f]);
      if (hl.length === 0) {
        primary = 'w';
      } else if (occupied.some((h) => colorOf(g[h.r][h.f]) === oppColor)) {
        primary = myColor; // opponent just moved
      } else if (hl.length >= 2) {
        primary = oppColor; // I just moved
      } else {
        primary = myColor; // single highlight = my selected piece
      }
    }
    return [primary, primary === 'w' ? 'b' : 'w'];
  }

  if (globalThis.__SFX_TEST__) {
    globalThis.__SFX_TEST__ = { attacked, plausible, placementOf, buildFen, epSquare, updateRights, turnCandidates, START_PLACEMENT };
    return;
  }

  // ======================================================================
  // Settings + panel
  // ======================================================================
  const settings = { on: true, color: 'auto' };
  try {
    chrome.storage.local.get(['sfx'], (r) => {
      if (r && r.sfx) Object.assign(settings, r.sfx);
      refreshButtons();
    });
  } catch (e) {}

  function saveSettings() {
    try {
      chrome.storage.local.set({ sfx: settings });
    } catch (e) {}
  }

  let panel = null;
  let statusEl = null;
  let onBtn = null;
  let colorBtn = null;

  function ensurePanel() {
    if (panel && document.documentElement.contains(panel)) return;
    panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      left: '6px',
      bottom: '6px',
      zIndex: '2147483647',
      font: '12px/1.2 sans-serif',
      background: 'rgba(0,0,0,0.78)',
      color: '#fff',
      padding: '5px 8px',
      borderRadius: '14px',
      display: 'flex',
      gap: '8px',
      alignItems: 'center',
    });
    statusEl = document.createElement('span');
    onBtn = document.createElement('button');
    colorBtn = document.createElement('button');
    for (const b of [onBtn, colorBtn]) {
      Object.assign(b.style, {
        font: 'inherit',
        color: '#fff',
        background: '#444',
        border: '0',
        borderRadius: '8px',
        padding: '3px 7px',
      });
    }
    onBtn.addEventListener('click', () => {
      settings.on = !settings.on;
      saveSettings();
      forceRefresh();
      refreshButtons();
    });
    colorBtn.addEventListener('click', () => {
      settings.color = settings.color === 'auto' ? 'white' : settings.color === 'white' ? 'black' : 'auto';
      saveSettings();
      forceRefresh();
      refreshButtons();
    });
    panel.append(statusEl, onBtn, colorBtn);
    document.documentElement.appendChild(panel);
    refreshButtons();
  }

  function refreshButtons() {
    if (!panel) return;
    onBtn.textContent = settings.on ? 'ON' : 'OFF';
    colorBtn.textContent = 'Me: ' + settings.color;
  }

  function setStatus(t) {
    if (statusEl) statusEl.textContent = 'SF19 ' + t;
  }

  function removePanel() {
    if (panel) panel.remove();
    panel = null;
  }

  // ======================================================================
  // Board reading + overlay
  // ======================================================================
  const isBotPage = () => {
    const p = location.pathname.toLowerCase();
    return (
      p.includes('/computer') ||
      p.includes('/puzzles') ||
      p.includes('/puzzle') ||
      p.includes('/tactics') ||
      p.includes('/game/live') ||
      p.includes('/play/online') ||
      p.includes('/live') ||
      p.includes('/game/')
    );
  };
  const findBoard = () => document.querySelector('wc-chess-board, chess-board');

  function readBoard(board) {
    const g = Array.from({ length: 8 }, () => Array(8).fill(null));
    board.querySelectorAll('.piece').forEach((el) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      const p = /(?:^|\s)([wb])([pnbrqk])(?:\s|$)/.exec(cls);
      const s = /square-(\d)(\d)/.exec(cls);
      if (!p || !s) return;
      const f = +s[1] - 1;
      const r = +s[2] - 1;
      if (!inb(r, f)) return;
      g[r][f] = p[1] === 'w' ? p[2].toUpperCase() : p[2];
    });
    const hl = [];
    board.querySelectorAll('.highlight').forEach((el) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      const s = /square-(\d)(\d)/.exec(cls);
      if (s && inb(+s[2] - 1, +s[1] - 1)) hl.push({ f: +s[1] - 1, r: +s[2] - 1 });
    });
    let plies = null;
    document.querySelectorAll('[data-ply]').forEach((n) => {
      const v = parseInt(n.getAttribute('data-ply'), 10);
      if (!isNaN(v) && (plies === null || v > plies)) plies = v;
    });
    return { g, hl, plies, flipped: board.classList.contains('flipped') };
  }

  function ensureOverlay(board) {
    let o = null;
    for (const c of board.children) {
      if (c.classList && c.classList.contains('sfx-overlay')) o = c;
    }
    if (!o) {
      o = document.createElement('div');
      o.className = 'sfx-overlay';
      Object.assign(o.style, { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', pointerEvents: 'none', zIndex: '2' });
      board.appendChild(o);
    }
    return o;
  }

  function clearOverlay() {
    document.querySelectorAll('.sfx-overlay').forEach((o) => (o.textContent = ''));
  }

  function paint(board, flipped, squares) {
    const o = ensureOverlay(board);
    o.textContent = '';
    for (const sq of squares) {
      const f = sq.charCodeAt(0) - 97;
      const r = +sq[1] - 1;
      if (!inb(r, f)) continue;
      const d = document.createElement('div');
      Object.assign(d.style, {
        position: 'absolute',
        width: '12.5%',
        height: '12.5%',
        left: (flipped ? 7 - f : f) * 12.5 + '%',
        top: (flipped ? r : 7 - r) * 12.5 + '%',
        background: RED,
        boxSizing: 'border-box',
      });
      o.appendChild(d);
    }
  }

  // ======================================================================
  // Engine link
  // ======================================================================
  let port = null;
  let reqId = 0;
  let lastKey = '';
  let stable = 0;
  let requested = false;
  let rights = { K: true, Q: true, k: true, q: true };
  let lastPlies = null;
  let boardRef = null;
  let flippedRef = false;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'sf19' });
    } catch (e) {
      port = null;
      return;
    }
    port.onMessage.addListener(onEngineMsg);
    port.onDisconnect.addListener(() => {
      port = null;
    });
  }

  function fmtScore(m) {
    if (m.scoreType === 'mate') return 'M' + m.score;
    const v = m.score / 100;
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  function onEngineMsg(m) {
    if (!m) return;
    if (m.type === 'error') {
      setStatus('error: ' + m.message);
      return;
    }
    if (m.id !== reqId || !boardRef) return;
    if (m.type === 'info' || m.type === 'best') {
      const mv = m.move;
      if (!mv || mv === '(none)' || mv === '0000') {
        clearOverlay();
        setStatus('no moves');
        return;
      }
      const from = mv.slice(0, 2);
      const to = mv.slice(2, 4);
      paint(boardRef, flippedRef, [from, to]);
      if (m.type === 'info') {
        setStatus('d' + m.depth + ' ' + fmtScore(m) + '  ' + from + '→' + to);
      } else {
        setStatus('best ' + from + '→' + to);
      }
    }
  }

  function forceRefresh() {
    lastKey = '';
    stable = 0;
    requested = false;
    reqId++;
    if (port) port.postMessage({ type: 'stop' });
    clearOverlay();
  }

  // ======================================================================
  // Main loop
  // ======================================================================
  function tick() {
    if (!isBotPage()) {
      removePanel();
      clearOverlay();
      return;
    }
    const board = findBoard();
    if (!board) return;
    ensurePanel();
    if (!settings.on) {
      setStatus('off');
      return;
    }
    if (!port) connect();
    if (!port) {
      setStatus('no engine link');
      return;
    }

    const snap = readBoard(board);
    boardRef = board;
    flippedRef = snap.flipped;

    // Castling rights: track once-moved kings/rooks during the session.
    if (placementOf(snap.g) === START_PLACEMENT || (snap.plies !== null && lastPlies !== null && snap.plies < lastPlies)) {
      rights = { K: true, Q: true, k: true, q: true };
    }
    lastPlies = snap.plies;
    updateRights(rights, snap.g);

    const key = [placementOf(snap.g), snap.plies, snap.hl.map((h) => h.f + '' + h.r).join(','), snap.flipped, settings.color].join('|');
    if (key !== lastKey) {
      lastKey = key;
      stable = 0;
      requested = false;
      reqId++;
      clearOverlay();
      return;
    }
    stable++;
    if (stable < 1 || requested) return;

    const myColor = settings.color === 'auto' ? (snap.flipped ? 'b' : 'w') : settings.color === 'white' ? 'w' : 'b';
    const cands = turnCandidates(snap.g, snap.hl, snap.plies, myColor);
    const turn = cands.find((t) => plausible(snap.g, t));
    if (!turn) {
      setStatus('position unclear');
      requested = true;
      return;
    }
    requested = true;
    if (turn !== myColor) {
      setStatus('opponent thinking…');
      return;
    }
    const fen = buildFen(snap.g, turn, rights, snap.hl);
    setStatus('thinking…');
    port.postMessage({ type: 'analyze', id: reqId, fen });
  }

  setInterval(tick, POLL_MS);
})();
