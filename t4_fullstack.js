const { createStack } = require('./fullstack');
const { sleep, waitFor, check, summary } = require('./harness');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const parseBest = (st) => { const m = /BEST ([a-h][1-8])→([a-h][1-8])(=[QRBN])?/.exec(st); return m ? m[1] + m[2] + (m[3] ? m[3][1].toLowerCase() : '') : null; };
function fenFromPositionCommand(C, cmd) {
  let fen = START;
  let moves = [];
  if (cmd.startsWith('position fen ')) {
    const rest = cmd.slice('position fen '.length);
    const idx = rest.indexOf(' moves ');
    fen = idx < 0 ? rest : rest.slice(0, idx);
    if (idx >= 0) moves = rest.slice(idx + 7).trim().split(/\s+/).filter(Boolean);
  } else if (cmd.startsWith('position startpos moves ')) {
    moves = cmd.slice('position startpos moves '.length).trim().split(/\s+/).filter(Boolean);
  }
  for (const move of moves) fen = C.applyUci(fen, move) || fen;
  return fen;
}

(async () => {
  // =============== Run 1: me = white (auto), engine path, ponder, cache ===============
  let s = createStack({ settings: {} });
  const C = s.chess;
  s.setPosition(START, null, { bottomTurn: true });
  let t = Date.now();
  await waitFor(() => /BEST/.test(s.status()), 20000);
  console.log('  [S0] status:', s.status(), `(${Date.now() - t} ms)`);
  const m1 = parseBest(s.status());
  check('S0 start position (20 book candidates, ambiguous) goes to engine and shows a legal BEST', m1 && C.applyUci(START, m1) !== null && !/BOOK/.test(s.status()), s.status());
  check('S0b only ONE move is shown (2 highlighted squares, no ALT in status)', s.overlaySquares() === 2 && !/ALT/.test(s.status()), { sq: s.overlaySquares(), st: s.status() });

  // I play the best move -> opponent's turn -> ponder in background
  const oppFen = C.applyUci(START, m1);
  s.setPosition(oppFen, m1, { bottomTurn: false });
  await waitFor(() => /ponder \d+\/\d+/.test(s.status()), 10000);
  await waitFor(() => { const m = /ponder (\d+)\/(\d+)/.exec(s.status()); return m && m[1] === m[2]; }, 20000);
  console.log('  [S1] status:', s.status());
  check('S1 opponent turn: background ponder ran to completion', /ponder (\d+)\/\1/.test(s.status()), s.status());
  check('S1b overlay cleared while opponent is to move (no stale move shown)', s.overlaySquares() === 0, s.overlaySquares());

  // opponent plays a pondered reply
  const poss = s.log.cmds.filter((c) => c.startsWith('position ')).map((c) => fenFromPositionCommand(C, c));
  const total = +/ponder \d+\/(\d+)/.exec(s.status())[1];
  const kids = poss.slice(-total);
  const kidFen = kids[0];
  // find the move opp played
  const opp = C.parseFen(oppFen);
  const kidMove = C.legalMoves(opp).find((m) => C.positionKey(C.toFen(C.applyMove(opp, m))) === C.positionKey(kidFen)).uci;
  const goBefore = s.log.goCount;
  s.setPosition(kidFen.split(' ').slice(0, 4).join(' ') + ' 0 1', kidMove, { bottomTurn: true });
  t = Date.now();
  await waitFor(() => /⚡/.test(s.status()), 8000);
  const dt = Date.now() - t;
  console.log('  [S2] status:', s.status(), `(${dt} ms after the opponent's move appeared; existing 3-tick debounce included)`);
  check('S2 predicted reply -> BEST appears from cache (⚡), no new engine search', /⚡/.test(s.status()) && s.log.goCount === goBefore, { st: s.status(), go: s.log.goCount - goBefore });
  check('S2b cached BEST shown well before a fresh 3.5 s search could finish', dt < 2000, dt);
  const m2 = parseBest(s.status());
  check('S2c cached move is legal in the new position & single highlight pair', m2 && C.applyUci(kidFen, m2) !== null && s.overlaySquares() === 2, { m2, sq: s.overlaySquares() });

  // Stale-position protection: switch to a fresh position while a search is running.
  // stale protection: change position mid-analysis; only the new position's answer may be shown
  // Use a non-opening position to ensure this path runs a fresh engine search.
  const FAR = 'r2q1rk1/ppp2ppp/2np1n2/2b1p1B1/2B1P1b1/2NP1N2/PPP2PPP/R2Q1RK1 w - - 0 8';
  s.setPosition(FAR, 'f1e1', { bottomTurn: true });
  t = Date.now();
  await sleep(1600); // analysis for FAR is in flight
  const FAR2 = 'r2q1rk1/pp3ppp/2n1pn2/2bp4/3P4/2NBPN2/PP3PPP/R1BQ1RK1 w - - 0 9';
  const seen = [];
  const watch = setInterval(() => seen.push(s.status()), 25);
  s.setPosition(FAR2, 'c6d4'.replace('c6d4', 'd5d4'), { bottomTurn: true });
  await waitFor(() => /BEST/.test(s.status()) && !/thinking/.test(s.status()) && parseBest(s.status()) && C.applyUci(FAR2, parseBest(s.status())), 20000);
  await sleep(500);
  clearInterval(watch);
  const bests = seen.map(parseBest).filter(Boolean);
  const wrong = bests.filter((b) => !C.applyUci(FAR2, b));
  console.log('  [S4] moves displayed after switching positions:', [...new Set(bests)].join(','), '| final:', s.status());
  check('S4 after the position changed, only moves legal in the NEW position were ever displayed', bests.length > 0 && wrong.length === 0, wrong);

  // =============== Run 2: me = black, unambiguous opening-book move is instant ===============
  const s2 = createStack({ settings: { on: true, color: 'black' } });
  const BARNES = 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1'; // 1.f3 - black to move, exactly one book reply
  s2.setPosition(START, null, { flipped: true, bottomTurn: false }); // white (opponent) to move: start position is observed first
  await sleep(1700);
  s2.setPosition(BARNES, 'f2f3', { flipped: true, bottomTurn: true });
  t = Date.now();
  await waitFor(() => /BOOK BEST/.test(s2.status()), 8000);
  const dtB = Date.now() - t;
  console.log('  [B1] status:', s2.status(), `(${dtB} ms)`, '| opening:', s2.opening());
  check('B1 unambiguous book move shown without waiting for Stockfish', /BOOK BEST e7→e5/.test(s2.status()), s2.status());
  check('B1b shown within the normal 3-tick debounce (<2 s)', dtB < 2000, dtB);
  const goAtBook = s2.log.goCount;
  await sleep(2500);
  check('B2 no engine search started after the book move was shown (pending ponder cancelled)', s2.log.goCount === goAtBook && s2.log.outstanding === 0, { go: s2.log.goCount, at: goAtBook, out: s2.log.outstanding });
  check('B2b status stays BOOK (nothing overwrote it)', /BOOK BEST e7→e5/.test(s2.status()), s2.status());
  check('B3 one highlighted pair on the board', s2.overlaySquares() === 2, s2.overlaySquares());
  const f = summary();
  console.log('\nextra: engine violations (go while outstanding):', s.log.violations.length + s2.log.violations.length);
  s.cleanup(); s2.cleanup();
  process.exit(f || s.log.violations.length + s2.log.violations.length ? 1 : 0);
})();
