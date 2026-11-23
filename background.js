'use strict';

// Thin MV3 service worker. Real Stockfish lives in the offscreen document
// so the engine survives service-worker suspension and has a proper Worker context.

const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_REASON = 'WORKERS'; // closest valid reason for long-lived Worker/WASM

let creatingOffscreen = null;
const ports = new Map(); // id -> port (content script ports)

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  const reason = (chrome.offscreen.Reason && chrome.offscreen.Reason.WORKERS)
    || chrome.offscreen.Reason.BLOBS
    || 'BLOBS';

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [reason],
    justification: 'Host Stockfish WASM worker for chess analysis',
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

// Forward messages from content scripts to offscreen, and replies back.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sf19') return;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ports.set(id, port);

  port.onMessage.addListener(async (msg) => {
    try {
      await ensureOffscreen();
      // Tag with our internal port id so offscreen can route the reply
      chrome.runtime.sendMessage({
        target: 'offscreen',
        sourcePortId: id,
        ...msg,
      });
    } catch (e) {
      try {
        port.postMessage({ type: 'error', message: 'Offscreen/engine failed: ' + e.message });
      } catch (_) {}
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(id);
    // Tell offscreen to drop any pending work for this port
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'port-closed',
      sourcePortId: id,
    }).catch(() => {});
  });
});

// Replies coming back from offscreen
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.target !== 'background') return;

  const port = ports.get(msg.sourcePortId);
  if (!port) return;

  try {
    const { target, sourcePortId, ...payload } = msg;
    port.postMessage(payload);
  } catch (_) {
    // port already closed
  }
});

// Keep offscreen alive when possible (best-effort)
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen().catch(() => {});
});
