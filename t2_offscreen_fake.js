const { createOffscreen, sleep, waitFor, check, summary } = require('./harness');

const OPP = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';       // black (opponent) to move
const OTHER = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';

(async () => {
  // ---------- A. basic analyze + cache hit ----------
  {
    const o = createOffscreen();
    await waitFor(() => o.log.cmds.includes('isready'));
    o.send({ type: 'analyze', id: 1, fen: OTHER, sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 1));
    const r1 = o.replies.find((r) => r.type === 'best' && r.id === 1);
    check('A1 best reply carries id+key+move', r1 && r1.key === o.chess.positionKey(OTHER) && !!r1.move && r1.cached !== true, r1);
    const goBefore = o.log.searches.length;
    // same position, different (unreliable) clocks -> cache hit, no new engine search
    o.send({ type: 'analyze', id: 2, fen: OTHER.replace('2 3', '9 40'), sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 2), 500);
    const r2 = o.replies.find((r) => r.type === 'best' && r.id === 2);
    check('A2 repeat position answered from cache instantly', r2 && r2.cached === true && o.log.searches.length === goBefore, { r2, searches: o.log.searches.length });
    check('A3 single main MultiPV=1 search', o.log.searches[0].mpv === 1, o.log.searches[0]);
    check('A4 no go-while-searching violations', o.log.violations.length === 0, o.log.violations);
  }

  // ---------- B. stale protection: newer position wins ----------
  {
    const o = createOffscreen();
    await waitFor(() => o.log.cmds.includes('isready'));
    o.send({ type: 'analyze', id: 1, fen: OTHER, sourcePortId: 'p1' });
    await sleep(15); // A is searching (fake search ~70ms)
    o.send({ type: 'analyze', id: 2, fen: OPP, sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 2));
    await sleep(120);
    const bests = o.replies.filter((r) => r.type === 'best');
    check('B1 only the newest position is answered', bests.length === 1 && bests[0].id === 2 && bests[0].key === o.chess.positionKey(OPP), bests);
    check('B2 nothing for the old position leaks (info/best)', !o.replies.some((r) => r.id === 1), o.replies.filter((r) => r.id === 1));
    check('B3 stopped search result not cached', (() => { const n = o.log.searches.length; o.send({ type: 'analyze', id: 3, fen: OTHER, sourcePortId: 'p1' }); return true; })());
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 3));
    const r3 = o.replies.find((r) => r.type === 'best' && r.id === 3);
    check('B4 old (cancelled) position is analysed fresh, not served from cache', r3 && r3.cached !== true, r3);
    check('B5 no go-while-searching violations', o.log.violations.length === 0, o.log.violations);
  }

  // ---------- C. ponder -> instant answer for predicted replies ----------
  {
    const o = createOffscreen();
    await waitFor(() => o.log.cmds.includes('isready'));
    o.send({ type: 'ponder', id: 5, fen: OPP, sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'ponder-status' && r.done === r.total && r.total > 0), 4000);
    const st = o.replies.filter((r) => r.type === 'ponder-status');
    check('C1 ponder root uses MultiPV 5, children MultiPV 1', o.log.searches[0].mpv === 5 && o.log.searches.slice(1).every((s) => s.mpv === 1), o.log.searches);
    check('C2 up to 5 plausible replies pondered', st[st.length - 1].total === 5 && st[st.length - 1].done === 5, st);
    check('C3 ponder never sends best/info to the page', !o.replies.some((r) => r.type === 'best' || r.type === 'info'), o.replies.filter((r) => r.type === 'best' || r.type === 'info'));
    // every pondered reply: opponent plays it, we ask for the new position (clocks differ from engine's)
    const kids = o.log.searches.slice(1).map((s) => ({ fen: s.fen, positionCmd: s.positionCmd }));
    const before = o.log.searches.length;
    let allInstant = true, keysOk = true;
    kids.forEach((child, i) => {
      const f2 = child.fen.split(' ').slice(0, 4).join(' ') + ' 0 1'; // content-style clocks
      o.send({ type: 'analyze', id: 10 + i, fen: f2, positionCmd: child.positionCmd, sourcePortId: 'p1' });
    });
    await sleep(30);
    kids.forEach((child, i) => {
      const fen = child.fen;
      const r = o.replies.find((x) => x.type === 'best' && x.id === 10 + i);
      if (!r || r.cached !== true || r.source !== 'ponder') allInstant = false;
      if (!r || r.key !== o.chess.positionKey(fen)) keysOk = false;
    });
    check('C4 all predicted replies answered instantly from ponder cache', allInstant && o.log.searches.length === before, o.replies.filter((x) => x.type === 'best'));
    check('C5 cached replies carry the exact position key', keysOk);
    // unexpected reply -> fresh analysis
    o.send({ type: 'analyze', id: 20, fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 20));
    const r20 = o.replies.find((r) => r.type === 'best' && r.id === 20);
    check('C6 unexpected move triggers new analysis (not cached)', r20 && r20.cached !== true && o.log.searches.length === before + 1, r20);
    check('C7 no go-while-searching violations', o.log.violations.length === 0, o.log.violations);
  }

  // ---------- D. main preempts ponder; cancelled ponder is not cached ----------
  {
    const o = createOffscreen();
    await waitFor(() => o.log.cmds.includes('isready'));
    o.send({ type: 'ponder', id: 5, fen: OPP, sourcePortId: 'p1' });
    await waitFor(() => o.log.searches.length >= 2); // root done, first child running
    const child = o.log.searches[1];
    const stopsBefore = o.log.stops;
    const t0 = Date.now();
    o.send({ type: 'analyze', id: 6, fen: OTHER, sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 6));
    check('D1 ponder was stopped for the main analysis', o.log.stops === stopsBefore + 1, o.log.stops);
    check('D2 main analysis was the next search started', o.log.searches[2].fen === OTHER && o.log.searches[2].mt === 6500, o.log.searches[2]);
    await sleep(150);
    check('D3 ponder plan dropped (no further ponder searches)', o.log.searches.length === 3, o.log.searches.map((s) => s.fen));
    o.send({ type: 'analyze', id: 7, fen: child.fen, sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 7));
    const r7 = o.replies.find((r) => r.type === 'best' && r.id === 7);
    check('D4 half-finished ponder result was NOT cached', r7 && r7.cached !== true, r7);
    check('D5 no violations', o.log.violations.length === 0, o.log.violations);
  }

  // ---------- E. promotion of an in-flight ponder search ----------
  {
    const o = createOffscreen({ speed: 20 }); // slower fake search so we can catch it mid-flight
    await waitFor(() => o.log.cmds.includes('isready'));
    o.send({ type: 'ponder', id: 5, fen: OPP, sourcePortId: 'p1' });
    await waitFor(() => o.log.searches.length >= 2);
    const child = o.log.searches[1];
    const stopsBefore = o.log.stops, searchesBefore = o.log.searches.length;
    o.send({ type: 'stop', sourcePortId: 'p1' }); // content sends this when the board changes
    await sleep(5);
    check('E1 plain stop leaves the in-flight ponder search alone', o.log.stops === stopsBefore);
    o.send({ type: 'analyze', id: 6, fen: child.fen.split(' ').slice(0, 4).join(' ') + ' 0 1', positionCmd: child.positionCmd, sourcePortId: 'p1' });
    await sleep(5);
    check('E2 promotion does not restart/stop the search', o.log.stops === stopsBefore && o.log.searches.length === searchesBefore);
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 6), 3000);
    const r6 = o.replies.find((r) => r.type === 'best' && r.id === 6);
    check('E3 promoted ponder answers the real request with the right key', r6 && r6.key === o.chess.positionKey(child.fen), r6);
    await sleep(150);
    check('E4 remaining ponder plan dropped after promotion', o.log.searches.length === searchesBefore, o.log.searches.length);
    check('E5 no violations', o.log.violations.length === 0, o.log.violations);
  }

  // ---------- F. stop-all / port-closed cancel ponder ----------
  {
    const o = createOffscreen({ speed: 20 });
    await waitFor(() => o.log.cmds.includes('isready'));
    o.send({ type: 'ponder', id: 5, fen: OPP, sourcePortId: 'p1' });
    await waitFor(() => o.log.searches.length >= 2);
    o.send({ type: 'stop-all', sourcePortId: 'p1' });
    const n = o.log.searches.length;
    await sleep(300);
    check('F1 stop-all cancels ponder and plan', o.log.searches.length === n);
    o.send({ type: 'ponder', id: 6, fen: OPP, sourcePortId: 'p2' });
    await waitFor(() => o.log.searches.length > n);
    o.send({ type: 'port-closed', sourcePortId: 'p2' });
    const m = o.log.searches.length;
    await sleep(300);
    check('F2 port-closed cancels ponder', o.log.searches.length <= m + 0);
  }

  // ---------- G. LRU cap ----------
  {
    const o = createOffscreen({ speed: 500 });
    await waitFor(() => o.log.cmds.includes('isready'));
    const C = o.chess;
    // generate 70 distinct positions by walking random legal moves
    const fens = []; let pos = C.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const seen = new Set();
    while (fens.length < 140) {
      const ms = C.legalMoves(pos); if (!ms.length) break;
      pos = C.applyMove(pos, ms[Math.floor(rnd() * ms.length)]);
      const f = C.toFen(pos); const k = C.positionKey(f);
      if (!seen.has(k)) { seen.add(k); fens.push(f); }
    }
    for (let i = 0; i < fens.length; i++) {
      o.send({ type: 'analyze', id: 100 + i, fen: fens[i], sourcePortId: 'p1' });
      await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 100 + i), 2000);
    }
    const n = o.log.searches.length;
    o.send({ type: 'analyze', id: 900, fen: fens[fens.length - 1], sourcePortId: 'p1' });
    o.send({ type: 'analyze', id: 901, fen: fens[0], sourcePortId: 'p1' });
    await sleep(40);
    const rNew = o.replies.find((r) => r.id === 900 && r.type === 'best');
    check('G1 newest entry still cached', rNew && rNew.cached === true);
    await waitFor(() => o.replies.some((r) => r.id === 901 && r.type === 'best'), 2000);
    const rOld = o.replies.find((r) => r.id === 901 && r.type === 'best');
    check('G2 oldest entry evicted (cache capped at 128)', rOld && rOld.cached !== true && o.log.searches.length === n + 1, { cached: rOld && rOld.cached });
  }

  // ---------- H. out-of-order ids ----------
  {
    const o = createOffscreen();
    await waitFor(() => o.log.cmds.includes('isready'));
    o.send({ type: 'analyze', id: 10, fen: OTHER, sourcePortId: 'p1' });
    o.send({ type: 'analyze', id: 9, fen: OPP, sourcePortId: 'p1' }); // older id arriving late
    await sleep(200);
    check('H1 late/older request is ignored', !o.replies.some((r) => r.id === 9) && o.replies.some((r) => r.id === 10 && r.type === 'best'));
  }

  // ---------- I. key normalisation: wrong-position protection ----------
  {
    const o = createOffscreen();
    await waitFor(() => o.log.cmds.includes('isready'));
    const base = 'r3k2r/pppq1ppp/2n5/8/8/2N5/PPPQ1PPP/R3K2R w KQkq - 0 10';
    o.send({ type: 'analyze', id: 1, fen: base, sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 1));
    const n = o.log.searches.length;
    o.send({ type: 'analyze', id: 2, fen: base.replace('KQkq', 'Kkq'), sourcePortId: 'p1' });  // different castling rights
    o.send({ type: 'analyze', id: 3, fen: base.replace(' w ', ' b '), sourcePortId: 'p1' });   // other side to move
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 3), 2000);
    const r2 = o.replies.find((r) => r.type === 'best' && r.id === 2), r3 = o.replies.find((r) => r.type === 'best' && r.id === 3);
    check('I1 different castling rights / side to move never hit the cache', (!r2 || r2.cached !== true) && (!r3 || r3.cached !== true) && o.log.searches.length > n, { r2, r3 });
  }

  // ---------- J. identical board reached by different histories must not collide ----------
  {
    const o = createOffscreen();
    await waitFor(() => o.log.cmds.includes('isready'));
    const C = o.chess;
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const lineA = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
    const lineB = ['g1f3', 'b8c6', 'e2e4', 'e7e5'];
    const makeFen = (line) => line.reduce((fen, move) => C.applyUci(fen, move), start);
    const fenA = makeFen(lineA), fenB = makeFen(lineB);
    const cmdA = 'position startpos moves ' + lineA.join(' ');
    const cmdB = 'position startpos moves ' + lineB.join(' ');
    check('J1 test positions are a true transposition', C.positionKey(fenA) === C.positionKey(fenB), { fenA, fenB });

    o.send({ type: 'analyze', id: 1, fen: fenA, positionCmd: cmdA, sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 1));
    const searchesA = o.log.searches.length;
    check('J2 full UCI history reaches the engine', o.log.searches[searchesA - 1].positionCmd === cmdA, o.log.searches[searchesA - 1]);

    o.send({ type: 'analyze', id: 2, fen: fenB, positionCmd: cmdB, sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 2));
    const r2 = o.replies.find((r) => r.type === 'best' && r.id === 2);
    check('J3 same board with different history is analysed separately', r2 && r2.cached !== true && o.log.searches.length === searchesA + 1, r2);

    o.send({ type: 'analyze', id: 3, fen: fenA, positionCmd: cmdA, sourcePortId: 'p1' });
    await waitFor(() => o.replies.some((r) => r.type === 'best' && r.id === 3));
    const r3 = o.replies.find((r) => r.type === 'best' && r.id === 3);
    check('J4 exact same history is still served from cache', r3 && r3.cached === true && o.log.searches.length === searchesA + 1, r3);
  }

  const f = summary();
  process.exit(f ? 1 : 0);
})();
