const { createOffscreen, sleep, waitFor } = require('./harness');
(async () => {
  const o = createOffscreen({ speed: 2000 });
  await waitFor(() => o.log.cmds.includes('isready'));
  const C = o.chess;
  let pos = C.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const keys = new Set(); let id = 1;
  const snap = () => { global.gc(); return process.memoryUsage().heapUsed / 1048576; };
  const base = snap(); const marks = [];
  for (let i = 0; i < 3000; i++) {
    const ms = C.legalMoves(pos);
    if (!ms.length || pos.fullmove > 60) pos = C.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    else pos = C.applyMove(pos, ms[Math.floor(rnd() * ms.length)]);
    const fen = C.toFen(pos); keys.add(C.positionKey(fen));
    const myId = id++;
    o.send({ type: i % 3 === 0 ? 'ponder' : 'analyze', id: myId, fen, sourcePortId: 'p1' });
    if (i % 3 !== 0) await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === myId), 1000, 1);
    else await sleep(2);
    if ((i + 1) % 1000 === 0) { marks.push(+snap().toFixed(2)); o.replies.length = 0; }
  }
  await sleep(300);
  console.log('distinct positions analysed:', keys.size, '| heap MB after 1000/2000/3000 requests (base ' + base.toFixed(2) + '):', marks.join(' / '));
  // cache size observable through behaviour: re-ask the 100 most recent distinct positions
  process.exit(0);
})();
