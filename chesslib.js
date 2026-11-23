/* SF19 chess helpers: FEN parsing, legal move generation, move application and
 * a normalized position key. Pure functions, no DOM / chrome APIs, so the same
 * file is loaded by content.js (content script), offscreen.html and Node tests.
 * Grid convention matches content.js: g[rank][file], rank 0 = rank 1, file 0 = a.
 */
(function (root) {
  'use strict';

  const FILES = 'abcdefgh';
  const inb = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;
  const isWhite = (pc) => pc === pc.toUpperCase();
  const colorOf = (pc) => (isWhite(pc) ? 'w' : 'b');
  const sqName = (r, f) => FILES[f] + (r + 1);

  function emptyGrid() {
    return Array.from({ length: 8 }, () => Array(8).fill(null));
  }
  const cloneGrid = (g) => g.map((row) => row.slice());

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

  /** Lenient FEN parser (needs at least 4 fields). Returns null if unusable. */
  function parseFen(fen) {
    if (typeof fen !== 'string') return null;
    const p = fen.trim().split(/\s+/);
    if (p.length < 4) return null;
    const rows = p[0].split('/');
    if (rows.length !== 8) return null;
    if (!/^[wb]$/.test(p[1])) return null;
    if (!/^(?:-|[KQkq]+)$/.test(p[2])) return null;
    if (!/^(?:-|[a-h][36])$/.test(p[3])) return null;
    const g = emptyGrid();
    let wk = 0, bk = 0;
    for (let ri = 0; ri < 8; ri++) {
      let f = 0;
      for (const ch of rows[ri]) {
        if (ch >= '1' && ch <= '8') f += Number(ch);
        else if ('pnbrqkPNBRQK'.includes(ch)) {
          if (f > 7) return null;
          g[7 - ri][f++] = ch;
          if (ch === 'K') wk++;
          if (ch === 'k') bk++;
        } else return null;
      }
      if (f !== 8) return null;
    }
    if (wk !== 1 || bk !== 1) return null;
    return {
      g,
      turn: p[1],
      rights: { K: p[2].includes('K'), Q: p[2].includes('Q'), k: p[2].includes('k'), q: p[2].includes('q') },
      ep: p[3] === '-' ? null : { f: p[3].charCodeAt(0) - 97, r: Number(p[3][1]) - 1 },
      halfmove: p[4] !== undefined && /^\d+$/.test(p[4]) ? Number(p[4]) : 0,
      fullmove: p[5] !== undefined && /^[1-9]\d*$/.test(p[5]) ? Number(p[5]) : 1,
    };
  }

  function castlingString(rights) {
    const s = (rights.K ? 'K' : '') + (rights.Q ? 'Q' : '') + (rights.k ? 'k' : '') + (rights.q ? 'q' : '');
    return s || '-';
  }

  function toFen(pos) {
    return [
      placementOf(pos.g),
      pos.turn,
      castlingString(pos.rights),
      pos.ep ? sqName(pos.ep.r, pos.ep.f) : '-',
      String(pos.halfmove),
      String(pos.fullmove),
    ].join(' ');
  }

  /** Rights that are consistent with king/rook placement. */
  function effectiveRights(g, rights) {
    return {
      K: !!rights.K && g[0][4] === 'K' && g[0][7] === 'R',
      Q: !!rights.Q && g[0][4] === 'K' && g[0][0] === 'R',
      k: !!rights.k && g[7][4] === 'k' && g[7][7] === 'r',
      q: !!rights.q && g[7][4] === 'k' && g[7][0] === 'r',
    };
  }

  /** En-passant square is only meaningful when a pawn of the side to move can capture. */
  function epCapturable(g, turn, ep) {
    if (!ep) return false;
    const pawn = turn === 'w' ? 'P' : 'p';
    const pr = turn === 'w' ? ep.r - 1 : ep.r + 1;
    if (pr < 0 || pr > 7) return false;
    return [ep.f - 1, ep.f + 1].some((ff) => inb(pr, ff) && g[pr][ff] === pawn);
  }

  /**
   * Normalized position identity: placement, side to move, effective castling,
   * en-passant only when capturable. Move counters are deliberately excluded
   * because board scraping cannot reconstruct them reliably.
   */
  function positionKey(fenOrPos) {
    const pos = typeof fenOrPos === 'string' ? parseFen(fenOrPos) : fenOrPos;
    if (!pos) return null;
    const rights = effectiveRights(pos.g, pos.rights);
    const ep = epCapturable(pos.g, pos.turn, pos.ep) ? sqName(pos.ep.r, pos.ep.f) : '-';
    return [placementOf(pos.g), pos.turn, castlingString(rights), ep].join(' ');
  }

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

  function kingSquare(g, color) {
    const k = color === 'w' ? 'K' : 'k';
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) if (g[r][f] === k) return [r, f];
    return null;
  }

  const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  const KING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function mk(fr, ff, tr, tf, promo, flag) {
    return {
      from: [fr, ff], to: [tr, tf], promo: promo || null, flag: flag || null,
      uci: sqName(fr, ff) + sqName(tr, tf) + (promo || ''),
    };
  }

  function pseudoMoves(pos) {
    const { g, turn } = pos;
    const them = turn === 'w' ? 'b' : 'w';
    const rights = effectiveRights(g, pos.rights);
    const out = [];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const pc = g[r][f];
        if (!pc || colorOf(pc) !== turn) continue;
        const t = pc.toLowerCase();
        if (t === 'p') {
          const dir = turn === 'w' ? 1 : -1;
          const startRank = turn === 'w' ? 1 : 6;
          const lastRank = turn === 'w' ? 7 : 0;
          const push = (tr, tf, flag) => {
            if (tr === lastRank) for (const pr of ['q', 'r', 'b', 'n']) out.push(mk(r, f, tr, tf, pr, flag));
            else out.push(mk(r, f, tr, tf, null, flag));
          };
          if (inb(r + dir, f) && !g[r + dir][f]) {
            push(r + dir, f);
            if (r === startRank && !g[r + 2 * dir][f]) out.push(mk(r, f, r + 2 * dir, f, null, 'double'));
          }
          for (const df of [-1, 1]) {
            const tr = r + dir, tf = f + df;
            if (!inb(tr, tf)) continue;
            const tp = g[tr][tf];
            if (tp && colorOf(tp) === them) push(tr, tf);
            else if (!tp && pos.ep && pos.ep.r === tr && pos.ep.f === tf) {
              const cap = g[r][tf];
              if (cap === (turn === 'w' ? 'p' : 'P')) out.push(mk(r, f, tr, tf, null, 'ep'));
            }
          }
        } else if (t === 'n' || t === 'k') {
          for (const [dr, df] of (t === 'n' ? KNIGHT : KING)) {
            const tr = r + dr, tf = f + df;
            if (!inb(tr, tf)) continue;
            const tp = g[tr][tf];
            if (!tp || colorOf(tp) === them) out.push(mk(r, f, tr, tf));
          }
        } else {
          const dirs = t === 'b' ? DIAG : t === 'r' ? ORTHO : DIAG.concat(ORTHO);
          for (const [dr, df] of dirs) {
            let tr = r + dr, tf = f + df;
            while (inb(tr, tf)) {
              const tp = g[tr][tf];
              if (!tp) out.push(mk(r, f, tr, tf));
              else {
                if (colorOf(tp) === them) out.push(mk(r, f, tr, tf));
                break;
              }
              tr += dr; tf += df;
            }
          }
        }
      }
    }
    // Castling (king on e-file home square; rights already checked against placement)
    const hr = turn === 'w' ? 0 : 7;
    const king = turn === 'w' ? 'K' : 'k';
    if (g[hr][4] === king && !attacked(g, hr, 4, them)) {
      const ks = turn === 'w' ? rights.K : rights.k;
      const qs = turn === 'w' ? rights.Q : rights.q;
      if (ks && !g[hr][5] && !g[hr][6] && !attacked(g, hr, 5, them) && !attacked(g, hr, 6, them)) {
        out.push(mk(hr, 4, hr, 6, null, 'castleK'));
      }
      if (qs && !g[hr][3] && !g[hr][2] && !g[hr][1] && !attacked(g, hr, 3, them) && !attacked(g, hr, 2, them)) {
        out.push(mk(hr, 4, hr, 2, null, 'castleQ'));
      }
    }
    return out;
  }

  /** Board after a move, ignoring turn/rights bookkeeping (used for legality + apply). */
  function boardAfter(g, mv) {
    const n = cloneGrid(g);
    const [fr, ff] = mv.from, [tr, tf] = mv.to;
    let pc = n[fr][ff];
    n[fr][ff] = null;
    if (mv.flag === 'ep') n[fr][tf] = null;
    if (mv.promo) pc = isWhite(pc) ? mv.promo.toUpperCase() : mv.promo;
    n[tr][tf] = pc;
    if (mv.flag === 'castleK') { n[tr][5] = n[tr][7]; n[tr][7] = null; }
    if (mv.flag === 'castleQ') { n[tr][3] = n[tr][0]; n[tr][0] = null; }
    return n;
  }

  function legalMoves(pos) {
    const them = pos.turn === 'w' ? 'b' : 'w';
    const res = [];
    for (const mv of pseudoMoves(pos)) {
      const n = boardAfter(pos.g, mv);
      const ks = kingSquare(n, pos.turn);
      if (ks && !attacked(n, ks[0], ks[1], them)) res.push(mv);
    }
    return res;
  }

  function applyMove(pos, mv) {
    const g = boardAfter(pos.g, mv);
    const [fr, ff] = mv.from, [tr, tf] = mv.to;
    const moved = pos.g[fr][ff];
    const captured = pos.g[tr][tf] || (mv.flag === 'ep' ? 'x' : null);
    const rights = Object.assign({}, pos.rights);
    if (moved === 'K') { rights.K = false; rights.Q = false; }
    if (moved === 'k') { rights.k = false; rights.q = false; }
    for (const [r, f, key] of [[0, 0, 'Q'], [0, 7, 'K'], [7, 0, 'q'], [7, 7, 'k']]) {
      if ((fr === r && ff === f) || (tr === r && tf === f)) rights[key] = false;
    }
    const them = pos.turn === 'w' ? 'b' : 'w';
    let ep = null;
    if (mv.flag === 'double') {
      const cand = { f: ff, r: (fr + tr) / 2 };
      const enemyPawn = them === 'w' ? 'P' : 'p';
      if ([tf - 1, tf + 1].some((x) => inb(tr, x) && g[tr][x] === enemyPawn)) ep = cand;
    }
    const isPawn = moved.toLowerCase() === 'p';
    return {
      g,
      turn: them,
      rights,
      ep,
      halfmove: isPawn || captured ? 0 : pos.halfmove + 1,
      fullmove: pos.turn === 'b' ? pos.fullmove + 1 : pos.fullmove,
    };
  }

  function isInCheck(pos) {
    const k = kingSquare(pos.g, pos.turn);
    const them = pos.turn === 'w' ? 'b' : 'w';
    return !!k && attacked(pos.g, k[0], k[1], them);
  }

  /** SAN generation is also used to validate move-list text scraped from sites. */
  function sanForMove(pos, mv) {
    const [fr, ff] = mv.from, [tr, tf] = mv.to;
    const piece = pos.g[fr][ff];
    if (!piece) return '';
    let san;
    if (mv.flag === 'castleK') san = 'O-O';
    else if (mv.flag === 'castleQ') san = 'O-O-O';
    else {
      const type = piece.toLowerCase();
      const capture = !!pos.g[tr][tf] || mv.flag === 'ep';
      const dest = sqName(tr, tf);
      let prefix = '';
      if (type !== 'p') {
        prefix = piece.toUpperCase();
        const rivals = legalMoves(pos).filter((other) =>
          other.uci !== mv.uci && other.to[0] === tr && other.to[1] === tf &&
          pos.g[other.from[0]][other.from[1]] === piece
        );
        if (rivals.length) {
          const sameFile = rivals.some((other) => other.from[1] === ff);
          const sameRank = rivals.some((other) => other.from[0] === fr);
          if (!sameFile) prefix += FILES[ff];
          else if (!sameRank) prefix += String(fr + 1);
          else prefix += sqName(fr, ff);
        }
      } else if (capture) prefix = FILES[ff];
      san = prefix + (capture ? 'x' : '') + dest + (mv.promo ? '=' + mv.promo.toUpperCase() : '');
    }
    const next = applyMove(pos, mv);
    if (isInCheck(next)) san += legalMoves(next).length ? '+' : '#';
    return san;
  }

  function normalizeSan(san) {
    return String(san || '')
      .trim()
      .replace(/0/g, 'O')
      .replace(/[!?]+$/g, '')
      .replace(/[+#]+$/g, '')
      .replace(/\s*e\.p\.?$/i, '')
      .replace(/[+#]+$/g, '');
  }

  /** Resolve one SAN token to a legal move; null means the token is ambiguous or invalid. */
  function moveFromSan(pos, san) {
    const want = normalizeSan(san);
    if (!want) return null;
    const matches = legalMoves(pos).filter((mv) => normalizeSan(sanForMove(pos, mv)) === want);
    return matches.length === 1 ? matches[0] : null;
  }

  /** Replay SAN from a supplied root FEN. Returns {fen,moves} or null on any mismatch. */
  function replaySan(rootFen, sanTokens) {
    const root = parseFen(rootFen);
    if (!root || !Array.isArray(sanTokens)) return null;
    let pos = root;
    const moves = [];
    for (const token of sanTokens) {
      const mv = moveFromSan(pos, token);
      if (!mv) return null;
      moves.push(mv.uci);
      pos = applyMove(pos, mv);
    }
    return { fen: toFen(pos), moves };
  }

  /** Apply an engine move (UCI) to a FEN. Returns null when the move is not legal there. */
  function applyUci(fen, uci) {
    const pos = parseFen(fen);
    if (!pos || typeof uci !== 'string') return null;
    const want = uci.trim().toLowerCase();
    const mv = legalMoves(pos).find((m) => m.uci === want);
    return mv ? toFen(applyMove(pos, mv)) : null;
  }

  function hasLegalMoves(fen) {
    const pos = parseFen(fen);
    return !!pos && legalMoves(pos).length > 0;
  }

  const api = {
    parseFen, toFen, positionKey, legalMoves, applyMove, applyUci, hasLegalMoves,
    sanForMove, moveFromSan, replaySan,
    placementOf, effectiveRights, epCapturable,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SF19Chess = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
