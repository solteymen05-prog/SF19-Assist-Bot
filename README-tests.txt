Tests for SF19 Assist 2.6.0 (Node 18+; not part of the extension).
Run from this folder:
  node t1_perft.js              chesslib: perft vs published counts, applyUci, position key
  node book_stats.js            book key compatibility + derived book-move statistics
  node t2_offscreen_fake.js     offscreen.js logic with a scripted fake engine (history-sensitive cache, stale, preempt, promote, LRU)
  node t3_offscreen_real.js     offscreen.js with the REAL Stockfish 19 Lite (~32 s)
  node t4_fullstack.js          content.js + background.js + offscreen.js + real engine on a FAKE Chess.com DOM (~60 s)
  node --expose-gc t5_memory.js heap growth over 3000 requests
NOT covered: a real Chrome/Chromium run, the real Chess.com / Lichess DOM, the Lichess board reader.
