const C = require('../chesslib.js');
let fail = 0;
function perft(pos, d) {
  const ms = C.legalMoves(pos);
  if (d === 1) return ms.length;
  let n = 0;
  for (const m of ms) n += perft(C.applyMove(pos, m), d - 1);
  return n;
}
const cases = [
  ['start', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['pos3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['pos4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['pos5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['pos6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
];
for (const [name, fen, exp] of cases) {
  const pos = C.parseFen(fen);
  exp.forEach((e, i) => {
    const got = perft(pos, i + 1);
    const ok = got === e; if (!ok) fail++;
    console.log((ok ? 'PASS' : 'FAIL'), name, 'd' + (i + 1), got, ok ? '' : 'expected ' + e);
  });
}
// applyUci / key checks
function eq(name, a, b) { const ok = a === b; if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `got ${a} expected ${b}`); }
const S = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
eq('e4 (no ep: no adjacent pawn)', C.applyUci(S, 'e2e4'), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
eq('illegal move rejected', C.applyUci(S, 'e2e5'), null);
eq('ep set when adjacent pawn', C.applyUci('rnbqkbnr/pppp1ppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3'.replace('3pP3','3p4').replace('PPPP1PPP','PPPPPPPP'), 'd4d3') !== null, true);
eq('ep after double push w/ neighbour', C.applyUci('4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1', 'e2e4'), '4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1');
eq('ep capture removes pawn', C.applyUci('4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1', 'd4e3'), '4k3/8/8/8/8/4p3/8/4K3 w - - 0 2');
eq('castle K', C.applyUci('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1'), 'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1');
eq('castle Q black', C.applyUci('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', 'e8c8'), '2kr3r/8/8/8/8/8/8/R3K2R w KQ - 1 2');
eq('castle through check rejected', C.applyUci('r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1', 'e1g1'), null);
eq('promotion', C.applyUci('8/P6k/8/8/8/8/8/K7 w - - 0 1', 'a7a8q'), 'Q7/7k/8/8/8/8/8/K7 b - - 0 1');
eq('promotion w/o piece rejected', C.applyUci('8/P6k/8/8/8/8/8/K7 w - - 0 1', 'a7a8'), null);
eq('rook capture clears right', C.applyUci('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'a1a8'), 'R3k2r/8/8/8/8/8/8/4K2R b Kk - 0 1');
eq('key ignores clocks', C.positionKey(S), C.positionKey(S.replace('0 1', '17 40')));
eq('key drops uncapturable ep', C.positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
eq('key drops inconsistent right', C.positionKey('4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1'), '4k3/8/8/8/8/8/8/4K3 w - -');
eq('bad fen -> null key', C.positionKey('garbage'), null);

const san = C.replaySan(S, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
function lineCheck(name, got, want) { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `got ${JSON.stringify(got)} expected ${JSON.stringify(want)}`); }
lineCheck('SAN replay resolves a legal opening line', san && san.moves, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']);
lineCheck('SAN replay resulting position is exact', san && C.positionKey(san.fen), C.positionKey(C.applyUci(C.applyUci(C.applyUci(C.applyUci(C.applyUci(S, 'e2e4'), 'e7e5'), 'g1f3'), 'b8c6'), 'f1b5')));
lineCheck('SAN replay rejects an invalid sequence', C.replaySan(S, ['e4', 'e5', 'Qh9']), null);
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
