const C = require('../chesslib.js');
const book = require('../openings.json');
const keys = Object.keys(book);
let mism = 0, ep = 0, ex = [];
for (const k of keys) {
  const kk = C.positionKey(k + ' 0 1');
  if (kk !== k) { mism++; if (ex.length < 5) ex.push([k, kk]); }
  if (k.split(' ')[3] !== '-') ep++;
}
console.log('book keys', keys.length, 'keys differing from positionKey:', mism, 'with ep square:', ep);
console.log(ex);
// derived book moves for every book position (side to move = mover), count candidates
const lookup = (fen) => { const pos = C.parseFen(fen); const k = C.positionKey(pos); if (book[k]) return book[k];
  const parts = k.split(' '); if (parts[3] !== '-') { const alt = parts.slice(0,3).join(' ') + ' -'; if (book[alt]) return book[alt]; } return null; };
const dist = {};
let sample = [];
for (const k of keys) {
  const pos = C.parseFen(k + ' 0 1'); if (!pos) continue;
  let n = 0, last = null;
  for (const mv of C.legalMoves(pos)) { const ch = C.toFen(C.applyMove(pos, mv)); if (lookup(ch)) { n++; last = mv.uci; } }
  dist[n] = (dist[n] || 0) + 1;
  if (n === 1 && sample.length < 3) sample.push([k, last, book[k].name]);
}
console.log('candidate-count distribution over book positions:', dist);
console.log(sample);
const start = C.parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
let n = 0; for (const mv of C.legalMoves(start)) if (lookup(C.toFen(C.applyMove(start, mv)))) n++;
console.log('start position book candidates:', n, 'start in book?', !!book['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -']);
