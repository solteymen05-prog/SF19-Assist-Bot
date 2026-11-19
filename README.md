# SF19 Assist Bot — Chess Extension (Stockfish 19 Lite WASM)

A browser extension developed for Android (**Lemur Browser**) and desktop Chromium-based browsers to analyze chess positions and provide best move suggestions using the native **Stockfish 19 Lite (WebAssembly)** engine.

> **Disclaimer:** This project is solely for educational purposes, WebAssembly engine integration, and browser plugin architecture development. Use in online ranked games may violate the terms of service (ToS) of the respective platforms and may lead to account restrictions.

---

## Installation (Android — Lemur Browser)

Lemur Browser can install extensions directly from a `.zip` file, so you don't need to extract (unzip) the file.

1. Download the **`SF19_Assist_Bot_Puzzle_Live.zip`** file to your phone from the **Releases** section (or from within the repository).
> **Note:** GitHub's *Code > Download ZIP* option may not work directly because it places the files in an extra subfolder; you must download the **`SF19_Assist_Bot_Puzzle_Live.zip`** file.
2. Open **Lemur Browser** and go to the **Extensions** page from the top/bottom right menu (`⋮`) (or type `lemur://extensions` in the address bar).
3. Activate the **Developer mode** switch in the top right corner.
4. Tap the **`+ (from .zip/.crx/.user)`** button that appears in the top left. 5. Select the **`SF19_Assist_Bot_Puzzle_Live.zip`** file from your Downloads folder. The extension will be automatically installed and activated.

---

## Installation (Desktop — Chrome, Brave, Edge, Opera)

1. Download the `SF19_Assist_Bot_Puzzle_Live.zip` file and extract it to a folder (the `manifest.json` file should be directly inside the folder).
2. Type `chrome://extensions` into your browser's address bar and press Enter.
3. Turn on **Developer mode** from the top right.
4. Click the **Load unpacked** button and select the extracted folder.

---

## Project Structure

```text
├── manifest.json # Plugin configuration and permissions
├── background.js # Background service and message management
├── content.js # Board reading, analytics flow and interface
└── engine/
├── stockfish-19-lite-single.js # Stockfish UCI JS wrapper
└── stockfish-19-lite-single.wasm # Native Stockfish 19 Lite WASM engine
 