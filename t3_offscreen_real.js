const { createOffscreen, sleep, waitFor, check, summary } = require('./harness');
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
function fenFromPositionCommand(C, cmd) {
  let fen = START, moves = [];
  if (cmd.startsWith('position fen ')) {
    const rest = cmd.slice('position fen '.length), idx = rest.indexOf(' moves ');
    fen = idx < 0 ? rest : rest.slice(0, idx);
    if (idx >= 0) moves = rest.slice(idx + 7).trim().split(/\s+/).filter(Boolean);
  } else if (cmd.startsWith('position startpos moves ')) {
    moves = cmd.slice('position startpos moves '.length).trim().split(/\s+/).filter(Boolean);
  }
  for (const move of moves) fen = C.applyUci(fen, move) || fen;
  return fen;
}
(async () => {
  const o = createOffscreen({ real: true });
  const C = o.chess;
  await waitFor(() => o.log.cmds.includes('isready'), 10000);
  const FEN0 = START; // start position, white to move
  // 1) main analysis (real engine, up to 6.5 s)
  let t0 = Date.now();
  o.send({ type: 'analyze', id: 1, fen: FEN0, positionCmd: 'position startpos', sourcePortId: 'p1' });
  await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 1), 15000);
  const r1 = o.replies.find((r) => r.type === 'best' && r.id === 1);
  const infoSeen = o.replies.filter((r) => r.type === 'info' && r.id === 1);
  console.log('  main took', Date.now() - t0, 'ms; best', r1 && r1.move, 'depth', r1 && r1.lines[0] && r1.lines[0].depth, 'lines', r1 && r1.lines.length);
  check('R1 real engine returns a legal single best move with matching key', r1 && C.applyUci(FEN0, r1.move) !== null && r1.lines.length === 1 && r1.lines[0].move === r1.move && r1.key === C.positionKey(FEN0), r1);
  check('R2 info replies carry the position key', infoSeen.length > 0 && infoSeen.every((r) => r.key === C.positionKey(FEN0)));

  // 2) I "play" the best move -> opponent to move -> ponder
  const oppFen = C.applyUci(FEN0, r1.move);
  const g0 = o.log.goCount;
  t0 = Date.now();
  const oppCmd = 'position startpos moves ' + r1.move;
  o.send({ type: 'ponder', id: 2, fen: oppFen, positionCmd: oppCmd, sourcePortId: 'p1' });
  await waitFor(() => o.replies.some((r) => r.type === 'ponder-status' && r.id === 2 && r.total > 0 && r.done === r.total), 26000);
  const st = o.replies.filter((r) => r.type === 'ponder-status' && r.id === 2);
  const last = st[st.length - 1];
  console.log('  ponder finished in', Date.now() - t0, 'ms; status', JSON.stringify(last), 'engine searches', o.log.goCount - g0);
  check('R3 ponder completed up to 5 opponent replies within budget (<23 s)', last && last.total >= 1 && last.total <= 5 && last.done === last.total && Date.now() - t0 < 23000, st);
  check('R4 ponder sent nothing displayable (no best/info) to the page', !o.replies.some((r) => r.id === 2 && (r.type === 'best' || r.type === 'info')));

  // 3) opponent plays a pondered move -> instant answer
  const childCommands = o.log.cmds.filter((c) => c.startsWith('position ')).slice(-last.total);
  const pondered = childCommands.map((c) => fenFromPositionCommand(C, c));
  const goBefore = o.log.goCount;
  t0 = Date.now();
  const kid = pondered[0], kidCmd = childCommands[0];
  o.send({ type: 'analyze', id: 3, fen: kid.split(' ').slice(0, 4).join(' ') + ' 0 1', positionCmd: kidCmd, sourcePortId: 'p1' });
  await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 3), 3000);
  const dt = Date.now() - t0;
  const r3 = o.replies.find((r) => r.type === 'best' && r.id === 3);
  console.log('  cached answer latency', dt, 'ms (move', r3 && r3.move, ')');
  check('R5 pondered position answered instantly from cache (<100 ms, no new search)', r3 && r3.cached === true && dt < 100 && o.log.goCount === goBefore && C.applyUci(kid, r3.move) !== null, { r3, dt });

  // Unexpected-move freshness and stale-result protection are exercised by t4_fullstack.js.

  // Real-worker cancellation/preemption is also exercised by t4_fullstack.js.
  const f = summary();
  o.cleanup();
  process.exit(f ? 1 : 0);
})();
