SF19 Assist v2.6.0 (history-aware analysis + stable board overlay)

WHAT CHANGED IN 2.6.0
- Complete observed UCI move history is sent to Stockfish. From the standard
  start this uses `position startpos moves ...`; from a validated mid-game root
  it uses `position fen ... moves ...`. This lets Stockfish account for repetition
  and move-count history rather than analysing an isolated board snapshot.
- When a page exposes a move list, SAN moves are replayed and validated before
  trusting them. If a game is opened mid-position and its earlier moves cannot
  be recovered, the current FEN becomes an explicit partial root; unknown moves
  are never invented.
- Cache entries now include the move-history context. Identical-looking boards
  reached by different move orders no longer share repetition-sensitive results.
- The page is sampled every 35 ms and requires two matching samples before acting
  (about 70 ms after a board change). Only the single BEST move is highlighted.
- Red move squares are drawn in a viewport-fixed layer using the board's current
  screen rectangle. This avoids the old parent/positioning mismatch when a board
  is zoomed, resized, scrolled, or transformed.
- Fresh main search increased to 6.5 seconds, with a 128 MB hash table. One best
  move is streamed as soon as the engine reports it; the search can continue to
  improve the displayed move until it finishes.
- While the opponent is to move, the engine searches up to five plausible replies
  (root search 1.3 s, then up to five child searches of 3.2 s each). If the opponent
  chooses one, the precomputed response is returned from cache. This is the path
  designed for sub-100 ms responses; an unexpected move still needs a fresh search.
- Mate detection stops early for mate-in-one, or when the same best move and exact
  mate score persist across successive deeper iterations. It does not claim that
  every forced mate can be found within 100 ms.
- Cache capacity increased to 128 entries. Engine hash is retained across moves
  instead of sending `ucinewgame` before every search.

ENGINE STRENGTH LIMITATION
The bundled engine is still `stockfish-19-lite-single` (about 1.85 MB WASM), not
full Stockfish 19. The upstream Stockfish.js project says the Lite build uses a
much smaller neural network and is considerably weaker. Its full single-threaded
Stockfish 19 build is about 99 MB for the WASM file and works without cross-origin
isolation, but that asset could not be fetched in this build environment. Therefore
this release improves analysis time, history, caching, and UI stability, but does
NOT silently claim to upgrade the underlying evaluation network.

PREVIOUS (2.5.0) FEATURES RETAINED
- Only one move is shown (BEST); no alternative arrows or ALT label.
- Opening names are looked up from openings.json. Since this database contains
  position keys rather than repertoire moves, an instant BOOK BEST is shown only
  when exactly one legal move leads to another known book position.
- Main analysis preempts background pondering. Stopped or cancelled results cannot
  leak to a later position. Every reply includes a position key and content.js
  rejects stale or illegal moves before drawing them.
- Chess.com and Lichess are supported. Position, turn, castling and en-passant
  validation remain conservative where the page does not expose reliable data.

INSTALL
1. Extract this ZIP to a folder.
2. Open chrome://extensions (or your Chromium browser's extensions page).
3. Enable Developer mode.
4. Choose Load unpacked and select the extracted folder containing manifest.json.
5. Refresh Chess.com or Lichess.

TESTS (Node.js 18+)
Run from the extracted folder:
  node tests/t1_perft.js
  node tests/t2_offscreen_fake.js
  node tests/t3_offscreen_real.js
  node tests/t4_fullstack.js
  node --expose-gc tests/t5_memory.js

IMPORTANT LIMITATIONS
- A newly encountered, unpredicted position still needs a full search; 100 ms is
  not a realistic guarantee for arbitrary positions on a single-threaded Lite engine.
- Pondering is opportunistic. It can finish while the opponent thinks, but a very
  short opponent turn or a busy tab may leave fewer cached replies ready.
- The built-in opening database has 11,953 ECO position keys. It is an opening-name
  lookup, not a complete opening repertoire or a best-move book.
- The exact halfmove clock is available only when the page supplies a valid FEN.
  Board-only scraping cannot always reconstruct it.
- If a game is opened mid-position and no move list or authoritative history is
  available, repetition history before that FEN is unknowable and is not fabricated.
- If side to move cannot be determined safely from FEN, clocks, or selected move,
  analysis is withheld rather than guessing.
- This is an analysis aid. Follow Chess.com/Lichess fair-play rules; do not use
  engine assistance in games where outside assistance is prohibited.

ENGINE FILES
`engine/stockfish-19-lite-single.js` and its matching `.wasm` are retained from the
original package. The JS/WASM pairing must stay together in the engine/ folder.
