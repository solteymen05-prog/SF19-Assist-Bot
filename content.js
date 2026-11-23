(() => {
  'use strict';

  const POLL_MS = 35;
  const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const START_KEY = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
  const LINE_COLORS = ['rgba(255, 40, 40, 0.58)'];
  // chesslib.js (loaded before this file). Without it the new book-move and
  // position-key features are skipped and the extension behaves as before.
  const SF = (typeof self !== 'undefined' && self.SF19Chess) || null;

  // ======================================================================
  // Pure chess helpers
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
        let rr = r + dr, ff = f + df;
        while (inb(rr, ff)) {
          const pc = g[rr][ff];
          if (pc) {
            if (isBy(pc, types)) return true;
            break;
          }
          rr += dr; ff += df;
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
    let found = null, count = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (g[r][f] === k) { found = [r, f]; count++; }
      }
    }
    return count === 1 ? found : null;
  }

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
      let s = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const pc = g[r][f];
        if (!pc) empty++;
        else {
          if (empty) { s += empty; empty = 0; }
          s += pc;
        }
      }
      if (empty) s += empty;
      rows.push(s);
    }
    return rows.join('/');
  }

  /** EP only if last move was a 2-square pawn push (detected via highlights). */
  function epSquare(g, hl, turn) {
    if (!hl || hl.length < 2) return '-';
    // The side that just moved is the opposite of `turn`
    const mover = turn === 'w' ? 'b' : 'w';
    const pawn = mover === 'w' ? 'P' : 'p';
    const startRank = mover === 'w' ? 1 : 6;
    const endRank = mover === 'w' ? 3 : 4;
    const enemyPawn = turn === 'w' ? 'P' : 'p';

    // Find destination square occupied by mover's pawn on endRank
    let to = null;
    for (const h of hl) {
      if (g[h.r][h.f] === pawn && h.r === endRank) { to = h; break; }
    }
    if (!to) return '-';

    // Origin should be empty startRank same file (highlight of from-square)
    const from = hl.find((h) => h.f === to.f && h.r === startRank && !g[h.r][h.f]);
    if (!from) return '-';

    // Only meaningful if an enemy pawn could capture EP
    const adj = [to.f - 1, to.f + 1].some((ff) => inb(to.r, ff) && g[to.r][ff] === enemyPawn);
    if (!adj) return '-';

    const midRank = (startRank + endRank) / 2;
    return String.fromCharCode(97 + to.f) + (midRank + 1);
  }

  function castlingString(rights) {
    const s = (rights.K ? 'K' : '') + (rights.Q ? 'Q' : '') + (rights.k ? 'k' : '') + (rights.q ? 'q' : '');
    return s || '-';
  }

  /** Shrink rights from piece placement (never invent rights mid-game). */
  function updateRightsFromBoard(rights, g) {
    if (g[0][4] !== 'K') { rights.K = false; rights.Q = false; }
    if (g[0][7] !== 'R') rights.K = false;
    if (g[0][0] !== 'R') rights.Q = false;
    if (g[7][4] !== 'k') { rights.k = false; rights.q = false; }
    if (g[7][7] !== 'r') rights.k = false;
    if (g[7][0] !== 'r') rights.q = false;
  }

  function buildFen(g, turn, rights, hl, halfmove, fullmove) {
    const hm = typeof halfmove === 'number' && halfmove >= 0 ? halfmove : 0;
    const fm = typeof fullmove === 'number' && fullmove >= 1 ? fullmove : 1;
    return [
      placementOf(g),
      turn,
      castlingString(rights),
      epSquare(g, hl, turn),
      String(hm),
      String(fm),
    ].join(' ');
  }

  function bookKeyFromFen(fen) {
    const p = fen.trim().split(/\s+/);
    if (p.length >= 4) return p.slice(0, 4).join(' ');
    return fen.trim();
  }

  // ======================================================================
  // Site detection
  // ======================================================================
  const SITE = (() => {
    const h = location.hostname;
    if (h.includes('chess.com')) return 'chesscom';
    if (h.includes('lichess.org')) return 'lichess';
    return null;
  })();

  function isSupportedPage() {
    if (!SITE) return false;
    const p = location.pathname.toLowerCase();
    if (SITE === 'chesscom') {
      return (
        p.includes('/computer') || p.includes('/puzzles') || p.includes('/puzzle') ||
        p.includes('/tactics') || p.includes('/game/live') || p.includes('/play/online') ||
        p.includes('/live') || p.includes('/game/')
      );
    }
    return (
      p === '/' || p.startsWith('/@/') || /^\/[a-zA-Z0-9]{8,}(\/|$)/.test(p) ||
      p.includes('/training') || p.includes('/puzzle') || p.includes('/analysis') ||
      p.includes('/study') || p.includes('/tv') || p.includes('/round') ||
      p.includes('/game') || p.includes('/play') || p.includes('/tournament') ||
      p.includes('/swiss') || p.includes('/broadcast')
    );
  }

  // ======================================================================
  // Opening book (loaded once from packaged openings.json)
  // Source: eco.json / niklasf eco_tsv (MIT-style open chess openings data)
  // ======================================================================
  let openingsBook = null;
  let openingsLoading = false;

  function loadOpeningsBook() {
    if (openingsBook || openingsLoading) return;
    openingsLoading = true;
    try {
      const url = chrome.runtime.getURL('openings.json');
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          openingsBook = data || {};
          openingsLoading = false;
        })
        .catch(() => {
          openingsBook = {};
          openingsLoading = false;
        });
    } catch (e) {
      openingsBook = {};
      openingsLoading = false;
    }
  }

  function lookupOpening(fen) {
    if (!openingsBook) return null;
    const key = bookKeyFromFen(fen);
    if (openingsBook[key]) return openingsBook[key];
    // Try with normalized ep "-" if specific ep square missed in book keys
    const parts = key.split(' ');
    if (parts.length >= 4 && parts[3] !== '-') {
      const alt = parts[0] + ' ' + parts[1] + ' ' + parts[2] + ' -';
      if (openingsBook[alt]) return openingsBook[alt];
    }
    return null;
  }

  /**
   * The opening book only maps positions to opening names, it has no moves.
   * A book move is therefore derived: a legal move whose resulting position is
   * itself in the book. It is returned only when exactly ONE such move exists;
   * with several candidates the book cannot say which is best, so the engine
   * decides.
   */
  function bookMoveFor(fen) {
    if (!SF || !openingsBook) return null;
    const pos = SF.parseFen(fen);
    if (!pos) return null;
    let hit = null;
    for (const mv of SF.legalMoves(pos)) {
      const op = lookupOpening(SF.toFen(SF.applyMove(pos, mv)));
      if (!op) continue;
      if (hit) return null; // ambiguous
      hit = { move: mv.uci, op };
    }
    return hit;
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
    try { chrome.storage.local.set({ sfx: settings }); } catch (e) {}
  }

  let panel = null, statusEl = null, openEl = null, onBtn = null, colorBtn = null;

  function ensurePanel() {
    if (panel && document.documentElement.contains(panel)) return;
    panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed', left: '6px', bottom: '6px', zIndex: '2147483647',
      font: '12px/1.2 sans-serif', background: 'rgba(0,0,0,0.78)', color: '#fff',
      padding: '5px 8px', borderRadius: '14px', display: 'flex', gap: '8px',
      alignItems: 'center', flexWrap: 'wrap', maxWidth: '92vw',
    });
    statusEl = document.createElement('span');
    openEl = document.createElement('span');
    Object.assign(openEl.style, { opacity: '0.9', fontSize: '11px' });
    onBtn = document.createElement('button');
    colorBtn = document.createElement('button');
    for (const b of [onBtn, colorBtn]) {
      Object.assign(b.style, {
        font: 'inherit', color: '#fff', background: '#444', border: '0',
        borderRadius: '8px', padding: '3px 7px',
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
    panel.append(statusEl, openEl, onBtn, colorBtn);
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

  function setOpening(text) {
    if (openEl) openEl.textContent = text || '';
  }

  function removePanel() {
    if (panel) panel.remove();
    panel = null;
  }

  // ======================================================================
  // Try read authoritative FEN from page UI (analysis / share boxes)
  // ======================================================================
  function readPageFen() {
    // Chess.com / Lichess analysis copyable FEN inputs
    const selectors = [
      'input.copyable',
      'textarea.copyable',
      'input[name="fen"]',
      '.copyable',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const v = (el.value || el.textContent || '').trim();
        if (/^[rnbqkpRNBQKP1-8]+\/[rnbqkpRNBQKP1-8/]+ [wb] /.test(v)) return v;
      }
    }
    return null;
  }

  function parseFenToGrid(fen) {
    if (typeof fen !== 'string') return null;
    const parts = fen.trim().split(/\s+/);
    if (parts.length !== 6) return null;
    const rows = parts[0].split('/');
    if (rows.length !== 8 || !/^[wb]$/.test(parts[1])) return null;
    if (!/^(?:-|[KQkq]+)$/.test(parts[2]) ||
        (parts[2] !== '-' && (new Set(parts[2]).size !== parts[2].length ||
          parts[2].split('').sort((a, b) => 'KQkq'.indexOf(a) - 'KQkq'.indexOf(b)).join('') !== parts[2])) ||
        !/^(?:-|[a-h][36])$/.test(parts[3])) return null;
    if (!/^\d+$/.test(parts[4]) || !/^[1-9]\d*$/.test(parts[5])) return null;
    const g = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (let ri = 0; ri < 8; ri++) {
      if (!/^[1-8pnbrqkPNBRQK]+$/.test(rows[ri]) || /[1-8]{2}/.test(rows[ri])) return null;
      let f = 0;
      for (const ch of rows[ri]) {
        if (ch >= '1' && ch <= '8') f += Number(ch);
        else if (/[pnbrqkPNBRQK]/.test(ch)) {
          if (f >= 8) return null;
          g[7 - ri][f++] = ch;
        } else return null;
      }
      if (f !== 8) return null;
    }
    if (g.flat().filter((x) => x === 'K').length !== 1 || g.flat().filter((x) => x === 'k').length !== 1) return null;
    const rights = { K: parts[2].includes('K'), Q: parts[2].includes('Q'), k: parts[2].includes('k'), q: parts[2].includes('q') };
    if ((rights.K && (g[0][4] !== 'K' || g[0][7] !== 'R')) ||
        (rights.Q && (g[0][4] !== 'K' || g[0][0] !== 'R')) ||
        (rights.k && (g[7][4] !== 'k' || g[7][7] !== 'r')) ||
        (rights.q && (g[7][4] !== 'k' || g[7][0] !== 'r'))) return null;
    if (parts[3] !== '-') {
      const epRank = parts[3][1];
      if ((parts[1] === 'w' && epRank !== '6') || (parts[1] === 'b' && epRank !== '3')) return null;
      const ef = parts[3].charCodeAt(0) - 97;
      const er = Number(epRank) - 1;
      const pawnRank = parts[1] === 'w' ? er - 1 : er + 1;
      const expectedPawn = parts[1] === 'w' ? 'p' : 'P';
      if (g[er][ef] || g[pawnRank]?.[ef] !== expectedPawn) return null;
    }
    return {
      g, turn: parts[1], rights,
      halfmove: Number(parts[4]), fullmove: Number(parts[5]), fenParts: parts,
    };
  }

  // ======================================================================
  // Chess.com board reading
  // ======================================================================
  function findBoardChessCom() {
    return document.querySelector('wc-chess-board, chess-board');
  }

  function readBoardChessCom(board) {
    const g = Array.from({ length: 8 }, () => Array(8).fill(null));
    board.querySelectorAll('.piece').forEach((el) => {
      const cls = typeof el.className === 'string' ? el.className : String(el.className || '');
      const p = /(?:^|\s)([wb])([pnbrqk])(?:\s|$)/i.exec(cls);
      const s = /square-(\d)(\d)/.exec(cls);
      if (!p || !s) return;
      const f = +s[1] - 1;
      const r = +s[2] - 1;
      if (!inb(r, f)) return;
      g[r][f] = p[1].toLowerCase() === 'w' ? p[2].toUpperCase() : p[2].toLowerCase();
    });
    const hl = [];
    board.querySelectorAll('.highlight').forEach((el) => {
      const cls = typeof el.className === 'string' ? el.className : String(el.className || '');
      const s = /square-(\d)(\d)/.exec(cls);
      if (s && inb(+s[2] - 1, +s[1] - 1)) hl.push({ f: +s[1] - 1, r: +s[2] - 1 });
    });
    // Only trust the currently selected move. Counting every node breaks when
    // the user browses an earlier move or a variation.
    let plies = null;
    const activePly = document.querySelector('[data-ply].active, [data-ply][aria-current="true"], .move-text-component.active[data-ply]');
    if (activePly) {
      const v = Number.parseInt(activePly.getAttribute('data-ply'), 10);
      if (Number.isInteger(v) && v >= 0) plies = v;
    }
    const flipped =
      board.classList.contains('flipped') ||
      !!(board.closest && board.closest('.flipped'));
    return { g, hl, plies, flipped: !!flipped };
  }

  // ======================================================================
  // Lichess (Chessground)
  // ======================================================================
  function findBoardLichess() {
    return document.querySelector('cg-board');
  }

  function detectLichessFlipped(board) {
    const wrap = board.closest('.cg-wrap') || board.parentElement;
    if (wrap) {
      if (wrap.classList.contains('orientation-black')) return true;
      if (wrap.classList.contains('orientation-white')) return false;
    }
    if (document.querySelector('.cg-wrap.orientation-black')) return true;
    const rankCoords = Array.from(document.querySelectorAll('coords.ranks coord'));
    if (rankCoords.length >= 1) {
      const topText = (rankCoords[0].textContent || '').trim();
      if (topText === '1') return true;
      if (topText === '8') return false;
    }
    return false;
  }

  function roleToFenChar(role, color) {
    const map = { king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p' };
    const c = map[role];
    if (!c) return null;
    return color === 'white' ? c.toUpperCase() : c;
  }

  function parseTransformXY(style) {
    const m = /translate\(\s*([-\d.]+)(?:px)?\s*,\s*([-\d.]+)(?:px)?\s*\)/.exec(style);
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
    const m2 = /matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([-\d.]+),\s*([-\d.]+)\)/.exec(style);
    if (m2) return [parseFloat(m2[1]), parseFloat(m2[2])];
    return null;
  }

  function readBoardLichess(board) {
    const g = Array.from({ length: 8 }, () => Array(8).fill(null));
    const flipped = detectLichessFlipped(board);
    const rect = board.getBoundingClientRect();
    const sq = rect.width / 8;
    if (sq < 5) return { g, hl: [], plies: null, flipped };

    board.querySelectorAll('piece').forEach((el) => {
      if (el.classList.contains('ghost')) return;
      const cls = (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '').toLowerCase();
      let color = cls.includes('white') ? 'white' : cls.includes('black') ? 'black' : null;
      let role = null;
      for (const r of ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn']) {
        if (cls.includes(r)) { role = r; break; }
      }
      if (!color || !role) return;

      let key = el.cgKey || el.getAttribute('cgKey') || el.getAttribute('data-key') || (el.dataset && el.dataset.key);
      let f, r;
      if (key && /^[a-h][1-8]$/.test(key)) {
        f = key.charCodeAt(0) - 97;
        r = +key[1] - 1;
      } else {
        // Bounding boxes work with Chessground's percentage transforms, pixel
        // transforms, zoom, and CSS scaling. Parsing translate() as pixels did not.
        const pr = el.getBoundingClientRect();
        const fileFromLeft = Math.floor((pr.left + pr.width / 2 - rect.left) / sq);
        const rankFromTop = Math.floor((pr.top + pr.height / 2 - rect.top) / sq);
        if (flipped) { f = 7 - fileFromLeft; r = rankFromTop; }
        else { f = fileFromLeft; r = 7 - rankFromTop; }
      }
      if (!inb(r, f)) return;
      const fenChar = roleToFenChar(role, color);
      if (fenChar) g[r][f] = fenChar;
    });

    const hl = [];
    board.querySelectorAll('square.last-move, square.selected').forEach((el) => {
      let key = el.cgKey || el.getAttribute('data-key') || (el.dataset && el.dataset.key);
      if (key && /^[a-h][1-8]$/.test(key)) {
        hl.push({ f: key.charCodeAt(0) - 97, r: +key[1] - 1 });
        return;
      }
      const hr = el.getBoundingClientRect();
      const fileFromLeft = Math.floor((hr.left + hr.width / 2 - rect.left) / sq);
      const rankFromTop = Math.floor((hr.top + hr.height / 2 - rect.top) / sq);
      let f, r;
      if (flipped) { f = 7 - fileFromLeft; r = rankFromTop; }
      else { f = fileFromLeft; r = 7 - rankFromTop; }
      if (inb(r, f)) hl.push({ f, r });
    });

    // Use the selected move node only. Total move count is not the current
    // position when a user steps backward or enters a variation.
    let plies = null;
    const moveNodes = Array.from(document.querySelectorAll('.tview2 move:not(.empty), .moves move'));
    const activeMove = document.querySelector('.tview2 move.active, .moves move.active, move.active');
    if (activeMove) {
      const explicit = Number.parseInt(activeMove.getAttribute('data-ply') || activeMove.getAttribute('ply') || '', 10);
      if (Number.isInteger(explicit) && explicit >= 0) plies = explicit;
      else {
        const idx = moveNodes.indexOf(activeMove);
        if (idx >= 0) plies = idx + 1;
      }
    }

    return { g, hl, plies, flipped };
  }

  function findBoard() {
    if (SITE === 'chesscom') return findBoardChessCom();
    if (SITE === 'lichess') return findBoardLichess();
    return null;
  }

  function readBoard(board) {
    if (SITE === 'chesscom') return readBoardChessCom(board);
    if (SITE === 'lichess') return readBoardLichess(board);
    return { g: Array.from({ length: 8 }, () => Array(8).fill(null)), hl: [], plies: null, flipped: false };
  }

  // ======================================================================
  // Overlay
  // ======================================================================
  let overlayEl = null;
  let overlayBoard = null;

  function placeOverlay(board, overlay) {
    if (!board || !overlay) return;
    const rect = board.getBoundingClientRect();
    if (!rect || rect.width < 8 || rect.height < 8) {
      overlay.style.display = 'none';
      return;
    }
    Object.assign(overlay.style, {
      display: 'block', position: 'fixed',
      left: rect.left + 'px', top: rect.top + 'px',
      width: rect.width + 'px', height: rect.height + 'px',
      pointerEvents: 'none', zIndex: '2147483000',
      margin: '0', padding: '0', border: '0',
    });
  }

  function ensureOverlay(board) {
    if (overlayEl && overlayBoard !== board) {
      overlayEl.remove();
      overlayEl = null;
    }
    if (!overlayEl || !document.documentElement.contains(overlayEl)) {
      overlayEl = document.createElement('div');
      overlayEl.className = 'sfx-overlay';
      overlayEl.setAttribute('aria-hidden', 'true');
      document.documentElement.appendChild(overlayEl);
      overlayBoard = board;
    }
    placeOverlay(board, overlayEl);
    return overlayEl;
  }

  function clearOverlay() {
    if (overlayEl) {
      overlayEl.textContent = '';
      overlayEl.style.display = 'none';
    }
  }

  function paintLines(board, flipped, lines) {
    const o = ensureOverlay(board);
    o.textContent = '';
    if (!lines || !lines.length) return;
    const rect = board.getBoundingClientRect();
    if (!rect || rect.width < 8 || rect.height < 8) return;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.move || line.move.length < 4) continue;
      const from = line.move.slice(0, 2);
      const to = line.move.slice(2, 4);
      const color = LINE_COLORS[i] || LINE_COLORS[0];
      for (const sq of [from, to]) {
        const f = sq.charCodeAt(0) - 97;
        const r = +sq[1] - 1;
        if (!inb(r, f)) continue;
        const d = document.createElement('div');
        Object.assign(d.style, {
          position: 'absolute',
          width: '12.5%', height: '12.5%',
          left: ((flipped ? 7 - f : f) * 12.5) + '%',
          top: ((flipped ? r : 7 - r) * 12.5) + '%',
          background: color, boxSizing: 'border-box',
          border: '2px solid rgba(255,255,255,0.65)',
          borderRadius: '2px',
        });
        o.appendChild(d);
      }
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
  // Castling: start UNKNOWN (all false). Only enable on start position.
  let rights = { K: false, Q: false, k: false, q: false };
  let seenStart = false;
  let lastPlies = null;
  let boardRef = null;
  let flippedRef = false;
  let halfmoveClock = 0;
  let cachedBoardEl = null;
  // '' = no engine reply expected; '*' = expected but position key unavailable;
  // otherwise the normalized position key the reply must carry.
  let expectKey = '';
  let ponderKey = '';
  let oppLabel = '';
  let currentFenRef = null;

  // Keep the complete observed game line. Stockfish's repetition logic only
  // works when UCI receives the moves from the game's root, not a lone FEN.
  let historyRootFen = null;
  let historyMoves = [];
  let lastHistoryFen = null;
  let lastHistoryPly = null;
  const historySnapshots = new Map();

  function fmtMove(uci) {
    const promotion = uci.length > 4 ? '=' + uci[4].toUpperCase() : '';
    return uci.slice(0, 2) + '→' + uci.slice(2, 4) + promotion;
  }

  function plyFromFen(fen) {
    const p = String(fen || '').trim().split(/\s+/);
    if (p.length !== 6 || !/^[1-9]\d*$/.test(p[5]) || !/^[wb]$/.test(p[1])) return null;
    return (Number(p[5]) - 1) * 2 + (p[1] === 'b' ? 1 : 0);
  }

  function findMoveBetween(fromFen, toFen) {
    if (!SF) return null;
    const from = SF.parseFen(fromFen);
    const wanted = SF.positionKey(toFen);
    if (!from || !wanted) return null;
    const matches = SF.legalMoves(from).filter((mv) =>
      SF.positionKey(SF.toFen(SF.applyMove(from, mv))) === wanted
    );
    return matches.length === 1 ? matches[0].uci : null;
  }

  function extractSanToken(node) {
    if (!node) return null;
    const raw = String(node.getAttribute && (node.getAttribute('data-san') || node.getAttribute('san')) || node.textContent || '').trim();
    if (!raw) return null;
    const tokens = raw.match(/(?:O-O-O|O-O|0-0-0|0-0|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?/g);
    if (!tokens || !tokens.length) return null;
    return tokens[tokens.length - 1].replace(/0/g, 'O');
  }

  function recoverHistoryFromMoveList(targetFen, targetPly) {
    if (!SF || typeof document.querySelectorAll !== 'function') return null;
    const selectors = SITE === 'lichess'
      ? ['.tview2 move:not(.empty)', '.moves move:not(.empty)']
      : ['.move-text-component[data-ply]', '.move-text-component .node', '.move-text-component'];
    const activeSelector = SITE === 'lichess'
      ? '.tview2 move.active, .moves move.active, move.active'
      : '[data-ply].active, [data-ply][aria-current="true"], .move-text-component.active[data-ply]';
    const active = document.querySelector(activeSelector);
    let candidates = [];
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector) || []);
      if (nodes.length > candidates.length) candidates = nodes;
    }
    if (!candidates.length) return null;
    let end = active ? candidates.indexOf(active) : -1;
    if (end >= 0) candidates = candidates.slice(0, end + 1);
    else if (targetPly !== null && targetPly !== undefined && candidates.length >= targetPly) {
      candidates = candidates.slice(0, targetPly);
    }
    const tokens = candidates.map(extractSanToken).filter(Boolean);
    if (!tokens.length) return null;
    const replay = SF.replaySan(START_FEN, tokens);
    if (!replay || SF.positionKey(replay.fen) !== SF.positionKey(targetFen)) return null;
    return replay.moves;
  }

  function saveHistorySnapshot(ply, fen) {
    if (ply === null || ply === undefined || !SF) return;
    historySnapshots.set(ply, {
      fen, rootFen: historyRootFen, moves: historyMoves.slice(),
    });
    // Bound memory for long analysis sessions.
    while (historySnapshots.size > 500) historySnapshots.delete(historySnapshots.keys().next().value);
  }

  function resetHistory(fen, ply) {
    historyRootFen = fen;
    historyMoves = [];
    lastHistoryFen = fen;
    lastHistoryPly = ply;
    historySnapshots.clear();
    saveHistorySnapshot(ply, fen);
  }

  function updateHistory(fen, ply) {
    if (!SF || !fen) return;
    const nowKey = SF.positionKey(fen);
    if (!nowKey) return;
    const lastKey = lastHistoryFen ? SF.positionKey(lastHistoryFen) : null;
    if (nowKey === lastKey) {
      lastHistoryFen = fen; // refresh counters without adding a move
      if (ply !== null) lastHistoryPly = ply;
      saveHistorySnapshot(ply, fen);
      return;
    }

    // A true new game starts with the normal initial position.
    if (nowKey === START_KEY && (ply === 0 || ply === null)) {
      resetHistory(START_FEN, 0);
      return;
    }

    // Browsing to a previously seen ply restores its exact branch history.
    if (ply !== null && historySnapshots.has(ply)) {
      const snap = historySnapshots.get(ply);
      if (SF.positionKey(snap.fen) === nowKey) {
        historyRootFen = snap.rootFen;
        historyMoves = snap.moves.slice();
        lastHistoryFen = fen;
        lastHistoryPly = ply;
        saveHistorySnapshot(ply, fen);
        return;
      }
    }

    // Append a move only when the last stable position and this position are
    // connected by exactly one legal move. This prevents animation frames or
    // arbitrary DOM changes from corrupting Stockfish's move history.
    const expectedNextPly = (lastHistoryPly === null || lastHistoryPly === undefined)
      ? null : lastHistoryPly + 1;
    const consecutive = ply === null || lastHistoryPly === null || ply === expectedNextPly;
    const uci = lastHistoryFen && consecutive ? findMoveBetween(lastHistoryFen, fen) : null;
    if (uci && historyRootFen) {
      historyMoves.push(uci);
      lastHistoryFen = fen;
      lastHistoryPly = ply;
      saveHistorySnapshot(ply, fen);
      return;
    }

    // On pages that expose the move list, recover the selected main line and
    // validate it by replaying SAN from the standard initial position.
    const recovered = recoverHistoryFromMoveList(fen, ply);
    if (recovered) {
      historyRootFen = START_FEN;
      historyMoves = recovered;
      lastHistoryFen = fen;
      lastHistoryPly = ply;
      saveHistorySnapshot(ply, fen);
      return;
    }

    // If the user jumped into a game before the extension observed its earlier
    // moves, start an honest partial line here. Never fabricate unknown moves.
    resetHistory(fen, ply);
  }

  function buildPositionCommand(fen) {
    if (!historyRootFen) return 'position fen ' + fen;
    if (historyRootFen === START_FEN) {
      return historyMoves.length
        ? 'position startpos moves ' + historyMoves.join(' ')
        : 'position startpos';
    }
    return 'position fen ' + historyRootFen + (historyMoves.length ? ' moves ' + historyMoves.join(' ') : '');
  }

  function connect() {
    if (port) {
      try { port.disconnect(); } catch (_) {}
      port = null;
    }
    try {
      port = chrome.runtime.connect({ name: 'sf19' });
    } catch (e) {
      port = null;
      return;
    }
    port.onMessage.addListener(onEngineMsg);
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(() => { if (!port) connect(); }, 400);
    });
  }

  function onEngineMsg(m) {
    if (!m) return;
    if (m.type === 'error') {
      requested = false;
      setStatus('engine error: ' + m.message);
      return;
    }
    // Ignore stale replies from a previous position
    if (m.id !== reqId || !boardRef) return;
    if (m.type === 'ponder-status') {
      if (SF && m.key && m.key === ponderKey && oppLabel) {
        setStatus(oppLabel + ' · ponder ' + m.done + '/' + m.total);
      }
      return;
    }
    if (m.type === 'info' || m.type === 'best') {
      // The reply must describe exactly the position that was requested.
      if (expectKey === '') return;
      if (expectKey !== '*' && m.key !== expectKey) return;
      const lines = (m.lines && m.lines.length)
        ? m.lines
        : (m.move ? [{ move: m.move, depth: m.depth, scoreType: m.scoreType, score: m.score }] : []);
      if (!lines.length || !lines[0].move || lines[0].move === '(none)' || lines[0].move === '0000') {
        clearOverlay();
        setStatus('no moves');
        return;
      }
      // Only ONE move is shown: the best one. Reject a move that is not legal
      // in the exact current FEN, even if a page transition raced the reply.
      const best = lines[0];
      if (SF && currentFenRef && !SF.applyUci(currentFenRef, best.move)) {
        clearOverlay();
        setStatus('discarded stale / illegal engine move');
        return;
      }
      paintLines(boardRef, flippedRef, [best]);
      let sc = '';
      if (best.scoreType === 'mate') sc = 'M' + best.score;
      else if (typeof best.score === 'number') sc = ((best.score > 0 ? '+' : '') + (best.score / 100).toFixed(1));
      const d = best.depth ? 'd' + best.depth + ' ' : '';
      setStatus(d + 'BEST ' + fmtMove(best.move) + (sc ? ' (' + sc + ')' : '') + (m.cached ? ' ⚡' : ''));
    }
  }

  function forceRefresh() {
    lastKey = '';
    stable = 0;
    requested = false;
    reqId++;
    expectKey = '';
    ponderKey = '';
    if (port) port.postMessage({ type: 'stop-all' });
    clearOverlay();
  }

  // ======================================================================
  // Turn / clocks from plies
  // ======================================================================
  function deriveClocks(plies) {
    if (plies === null || plies === undefined || isNaN(plies)) {
      return { halfmove: halfmoveClock, fullmove: 1 };
    }
    // plies = number of half-moves played; next fullmove number:
    const fullmove = Math.floor(plies / 2) + 1;
    // Without capture/pawn tracking, keep halfmove modest but non-constant
    return { halfmove: halfmoveClock, fullmove: fullmove < 1 ? 1 : fullmove };
  }

  function detectTurnFromDom(myColor, snap) {
    // Lichess clocks: side with .running is about to move / is active
    if (SITE === 'lichess') {
      const bottomRunning = document.querySelector('.rclock-bottom.running, .rclock.running.rclock-bottom');
      const topRunning = document.querySelector('.rclock-top.running, .rclock.running.rclock-top');
      if (bottomRunning && !topRunning) return myColor; // bottom = me
      if (topRunning && !bottomRunning) return myColor === 'w' ? 'b' : 'w';
    }
    if (SITE === 'chesscom') {
      const clockBottom = document.querySelector('.clock-bottom.clock-player-turn, .clock-bottom.turn');
      const clockTop = document.querySelector('.clock-top.clock-player-turn, .clock-top.turn');
      if (clockBottom && !clockTop) return myColor;
      if (clockTop && !clockBottom) return myColor === 'w' ? 'b' : 'w';
    }
    if (snap.plies !== null) {
      return snap.plies % 2 === 0 ? 'w' : 'b';
    }
    return null;
  }

  // ======================================================================
  // Main loop
  // ======================================================================
  function tick() {
    if (!isSupportedPage()) {
      removePanel();
      clearOverlay();
      cachedBoardEl = null;
      return;
    }

    let board = cachedBoardEl;
    if (!board || !document.documentElement.contains(board)) {
      board = findBoard();
      cachedBoardEl = board;
    }
    if (!board) return;

    ensurePanel();
    loadOpeningsBook();

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
    if (overlayEl && overlayEl.style.display !== 'none') placeOverlay(board, overlayEl);

    // Prefer page FEN when available (analysis boards)
    const pageFen = readPageFen();
    let pageParsed = pageFen ? parseFenToGrid(pageFen) : null;

    // Castling rights policy: only full rights after seeing start; else shrink only
    const placement = placementOf(snap.g);
    // Ignore a stale/hidden FEN input if it does not describe the visible board.
    if (pageParsed && placementOf(pageParsed.g) !== placement) pageParsed = null;
    if (placement === START_PLACEMENT) {
      rights = { K: true, Q: true, k: true, q: true };
      seenStart = true;
      halfmoveClock = 0;
    } else if (pageParsed) {
      rights = pageParsed.rights;
      halfmoveClock = pageParsed.halfmove;
    } else if (!seenStart) {
      // Opened mid-game: do not invent castling rights
      rights = { K: false, Q: false, k: false, q: false };
      updateRightsFromBoard(rights, snap.g);
    } else {
      updateRightsFromBoard(rights, snap.g);
    }

    // A lower ply can mean navigation to an earlier move, not a new game.
    // Reset rights only when the actual initial position is observed.
    lastPlies = snap.plies;

    const pageFenKey = pageFen ? pageFen.trim().split(/\s+/).join(' ') : '';
    const key = [placement, snap.plies, snap.hl.map((h) => h.f + '' + h.r).join(','), snap.flipped, settings.color, pageFenKey].join('|');
    if (key !== lastKey) {
      lastKey = key;
      stable = 0;
      requested = false;
      reqId++; // invalidate in-flight engine replies
      expectKey = '';
      ponderKey = '';
      if (port) port.postMessage({ type: 'stop' });
      clearOverlay();
      return;
    }
    stable++;
    if (stable < 2 || requested) {
      if (overlayEl && overlayEl.style.display !== 'none') placeOverlay(board, overlayEl);
      return;
    } // two matching samples: roughly 70 ms, rather than the old ~1 s delay

    let myColor;
    if (settings.color === 'white') myColor = 'w';
    else if (settings.color === 'black') myColor = 'b';
    else myColor = snap.flipped ? 'b' : 'w';

    if (!(findKing(snap.g, 'w') && findKing(snap.g, 'b'))) {
      setStatus('no kings');
      requested = true;
      return;
    }

    // Turn detection priority: page FEN > clocks/DOM > ply parity > plausible(myColor)
    let turn = null;
    if (pageParsed && pageParsed.turn) {
      turn = pageParsed.turn;
    } else {
      turn = detectTurnFromDom(myColor, snap);
    }
    if (!turn) {
      const myTurnPlausible = plausible(snap.g, myColor);
      const otherColor = myColor === 'w' ? 'b' : 'w';
      const otherTurnPlausible = plausible(snap.g, otherColor);
      // King-safety alone usually cannot determine the side to move. If both
      // interpretations are legal, stop instead of giving advice for the wrong side.
      if (myTurnPlausible !== otherTurnPlausible) turn = myTurnPlausible ? myColor : otherColor;
      else {
        clearOverlay();
        setOpening('');
        setStatus('turn unknown · select a position with a visible move/clock');
        requested = true;
        return;
      }
    }

    const clocks = pageParsed
      ? { halfmove: pageParsed.halfmove, fullmove: pageParsed.fullmove }
      : deriveClocks(snap.plies);
    const fen = pageParsed && pageParsed.fenParts
      ? pageFen
      : buildFen(snap.g, turn, rights, snap.hl, clocks.halfmove, clocks.fullmove);
    let currentPly;
    if (snap.plies !== null && snap.plies !== undefined) currentPly = snap.plies;
    else if (pageParsed) currentPly = plyFromFen(fen);
    else if (lastHistoryFen && SF && SF.positionKey(lastHistoryFen) !== SF.positionKey(fen) && lastHistoryPly !== null) {
      currentPly = lastHistoryPly + 1;
    } else currentPly = lastHistoryPly;
    updateHistory(fen, currentPly);
    currentFenRef = fen;
    const positionCmd = buildPositionCommand(fen);

    // If DOM says opponent to move, analyse likely replies in the background.
    if (turn !== myColor) {
      const op = lookupOpening(fen);
      if (op) setOpening((op.eco ? op.eco + ' · ' : '') + op.name);
      else setOpening('');
      oppLabel = 'opp (me:' + myColor + ' flip:' + (snap.flipped ? '1' : '0') + ')';
      setStatus(oppLabel);
      requested = true;
      if (SF) {
        const pk = SF.positionKey(fen);
        if (pk) {
          ponderKey = pk;
          port.postMessage({ type: 'ponder', id: reqId, fen, positionCmd });
          setStatus(oppLabel + ' · pondering');
        }
      }
      return;
    }

    const op = lookupOpening(fen);
    if (op) setOpening((op.eco ? op.eco + ' · ' : '') + op.name);
    else setOpening('');

    requested = true;

    // Unambiguous opening-book continuation: show immediately, no engine wait.
    const bm = bookMoveFor(fen);
    if (bm) {
      expectKey = '';
      ponderKey = '';
      port.postMessage({ type: 'stop-all' });
      paintLines(board, snap.flipped, [{ move: bm.move }]);
      setStatus('BOOK BEST ' + fmtMove(bm.move));
      return;
    }

    expectKey = (SF && SF.positionKey(fen)) || '*';
    setStatus('thinking… me:' + myColor);
    port.postMessage({ type: 'analyze', id: reqId, fen, positionCmd });
  }

  setInterval(tick, POLL_MS);
  loadOpeningsBook();
})();
