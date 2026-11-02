# Transfer engine rewrite (protocol v2)

**Both phones must run this version** — v2 frames are not readable by the old build.

## Heavy files
- Removed the 2 MB ceiling. Files up to 4 GB can be sent; the receiver accepts up to 768 MB.
- Sender no longer builds every frame up front. Frames are generated on demand a few ahead of the
  screen, so memory stays flat. Files > 96 MB are streamed from disk instead of loaded.
- The old 15 s "planning timed out" worker is gone. The CRC is hashed in 4 MB blocks with live
  "Preparing %" progress.
- Receiver writes chunks straight into one pre-allocated buffer (no per-chunk arrays/Maps).

## Speed
- Frames are base45 binary → QR alphanumeric mode: 900 payload bytes per QR at the same QR size
  that previously carried 700 (+29%).
- Max speed raised from 10 to 20 fps; playback is clocked with requestAnimationFrame and QR
  matrices are prepared ahead, so the rate holds steady. Default is 8 fps.
- Dropped the per-frame jsQR "verify" pass and the rounded-module/PNG data-URL rendering.
- Receiver uses the native BarcodeDetector when present (jsQR fallback), never queues decodes,
  and scans at 1280 px.
- After the first full pass the sender emits repair frames (random XOR combos per 256-chunk block).
  A receiver that missed frames needs ~1 repair per missing chunk instead of waiting for those exact
  frames to come around again. Simulated overhead: ~8% at 5% loss, ~14% at 30% loss on a 5 MB file.

## Bugs fixed
- Checksum failure used to dead-end with an error; it now discards and restarts cleanly.
- Sound/vibration fired on every frame at speed; now rate-limited.
- Side effects inside React state updaters (double sounds in StrictMode).
- Picking a new file mid-preparation could race with the previous one.
- History save failures (quota) no longer lose a freshly received file; large sent files are not
  duplicated into history.
- Sending stops when you leave the Send tab.

## Testing
`npm run test:protocol` — pure-protocol round trips with simulated frame loss / late join.
`scripts/qr-roundtrip-harness.ts` — renders + decodes real QR images (needs the app deps installed).


---

# Round 2: speed ceiling, UI rebuild, viewer, sound

## Throughput (measured / simulated)
- **Density presets** (Reliable 600 B · Balanced 900 B · Dense 1400 B · Max 2000 B per QR). Dense is only a
  version-28 QR (129 modules) because it uses EC level L, so it carries 2x the original 700 B at nearly the
  same on-screen module size. Max is 2.9x. Verified as real QR codes via OpenCV.
- **Speed up to 30 fps** (was 10). Theoretical ceiling: 2000 B x 30 fps ≈ 59 KB/s, ~8.6x the original ~6.8 KB/s.
- **Auto compression** (deflate-raw) for compressible files, skipped for JPEG/MP4/ZIP etc. via a 256 KB probe.
  Test file: 2.27 MB text -> 64 KB, 35x fewer frames.
- Block-based repair frames: ~8-15% overhead at 5-30% frame loss (the old loop-again approach cost ~100%).

## Receiver
- jsQR now runs in a Web Worker (UI never blocks on iOS / non-Chromium).
- Decoding is paced by `requestVideoFrameCallback` (one decode per real camera frame).
- Native `BarcodeDetector` reads the `<video>` directly (no canvas copy), at 1080p capture; reads every
  QR in view.
- Live throughput and ETA; checksum + length verified after decompression.

## UI
- **Tab pager**: real sliding panels that follow your finger, rubber-band at the ends, flick to commit,
  3D depth on neighbouring panels; the tab pill tracks the drag. Swipe is locked while the camera is live.
- **Camera layout**: immersive full-screen on phones (header + tab bar slide away), framed 16:9 stage on
  tablet/desktop; HUD with progress ring, speed, ETA, decoder type.
- **Send**: two-column layout on desktop, tilt-on-hover 3D QR card, fullscreen "presenter" QR (F), density
  picker, speed slider to 30.
- **Viewer**: tap any received/sent/history item to open full screen: pinch, double-tap and wheel zoom,
  pan, swipe-down to dismiss; video/audio players; Share / Save.
- Result card with verified badge, confetti, Share / Save / Receive more.
- Modals moved into portals so they are never clipped by the pager.

## Sound
- New synth engine: compressor, convolution reverb, FM bells, filtered envelopes, pentatonic palette.
- Scan tick rises in pitch as the transfer progresses; distinct open/close/swipe/success/error sounds.

## Tests
`npm run test:protocol`, `node --experimental-strip-types scripts/compress-test.ts`.

---

# Round 3: parity, bundles, layouts, Vercel

- **Identical QR on every frame.** The header frame and the final short chunk used to be much shorter than data
  frames and rendered as visibly smaller/sparser codes. Every frame type is now padded to exactly 9 + chunk bytes,
  so every QR in the stream has the same version and module grid (covered by a test at all four densities).
- **Multi-file sending.** Pick or drop many files; they are bundled into one stored `.zip` built from Blob parts
  (no memory copy), verified with Python `zipfile` and `unzip`. The receiver gets a normal zip.
- **Receiver**: removed manual zoom/pinch/pan/focus button entirely. Framing is now automatic: the view eases in
  until the code fills ~62% of the frame and re-centres on it, eases back out if the code is lost, and the lens
  autofocuses on the code itself. Resume after pause (progress is kept), screen wake-lock, unload warning
  mid-transfer, and a mobile-first idle screen.
- **Sender layout**: the QR is sized from its container (container query units) so it is as large as the space
  allows on any screen; desktop is a two-column layout with a large preview, stats and controls filling the full
  height; phones get a compact file row with a fixed square thumbnail so any image aspect ratio stays tidy.
- **Fullscreen presenter** redesigned: dark stage, QR as large as possible, title + exit on top, transport
  (play, progress, ETA, speed) below; becomes a side panel in landscape.
- **Deploy**: standard TanStack Start + Nitro Vite config (auto-selects Vercel at build), `vercel.json`, GitHub
  Actions CI, README deploy steps.

---

# Round 4: fixes from real-device screenshots

- **Send no longer scrolls on phones.** Compact file row (fixed square thumbnail), QR sized from remaining space,
  three tight control rows; desktop keeps the roomy two-column layout. Scrollbars are hidden on the shell.
- **Receive**: the camera is a bounded viewfinder (not the whole screen); progress/status and controls sit below it,
  never over the video. Header/tab bar stay put (removed the collapse trick that left a coloured strip).
  Auto-focus & framing is a toggle again (default on); off = plain camera.
- **Swiping**: Receive screen is swipeable again (the no-swipe flag was on the whole screen); you can also drag across
  the bottom tab bar to scrub between tabs. History filter uses one gliding pill.
- **Edge sliver / clipped HUD**: caused by my pager parallax pushing the neighbouring panel 6% into view at rest.
  Removed; off-screen panels are fully hidden once settled.
- **Fullscreen QR cut off on the right**: a grid column was being sized by the long filename; fixed with explicit
  minmax(0,1fr) tracks.
- **Performance**: QR encoding moved off the UI thread into a Web Worker pool (fixed mask pattern skips the 8-way mask
  scoring, ~4x faster), frames are blitted as pre-rendered bitmaps, up to 60 fps (Ultra), choice remembered.
  Receiver: camera requests 60 fps, jsQR runs in a worker, lighter UI updates, no per-scan vibration.
- **Dual QR (fullscreen)**: two codes per tick = 2x throughput; receiver reads multiple codes per frame natively and
  via a second jsQR pass.
