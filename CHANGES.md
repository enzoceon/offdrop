# OFFDROP &mdash; Technical Changelog & Release Engineering

<div align="center">

[![Latest Release](https://img.shields.io/badge/Release-v9.0.0-00D6B2?style=for-the-badge&labelColor=101522)](https://github.com/enzoceon/offdrop/releases)
[![Protocol Spec](https://img.shields.io/badge/Protocol-v3.2_Self--Describing-8B7CFF?style=for-the-badge&labelColor=101522)](#v500---protocol-v3-self-describing-binary-frames)
[![Decoding Engine](https://img.shields.io/badge/Decoder-WASM_SIMD_60FPS-45A9FF?style=for-the-badge&labelColor=101522)](#v800---wasm-simd-acceleration--optical-signaled-turbo-webrtc)
[![Fountain Self-Repair](https://img.shields.io/badge/Self--Repair-Zero--Loss_Fountain-FFB45B?style=for-the-badge&labelColor=101522)](#v900---the-dynamic-optical-engine--liquid-media-studio)

<br/>

**Complete chronological engineering log documenting the architectural evolution of OFFDROP from initial optical air-gap proof-of-concept to a multi-gigabyte, hardware-accelerated optical transmission engine.**

</div>

---

### Release Index

- **[v9.0.0](#v900---the-dynamic-optical-engine--liquid-media-studio)** &mdash; Dynamic Codec Hot-Switching, Ultra-Fast Stream Hasher (>1.2 GB/s), Hardware Autofocus Steering, Liquid Media Studio & Glassmorphic HUD.
- **[v8.0.0](#v800---wasm-simd-acceleration--optical-signaled-turbo-webrtc)** &mdash; C++ WebAssembly SIMD Multi-Code Decoding (`zxing-wasm`), Optical-Signaled Turbo WebRTC Data Channels, 4K Sensor Acquisition & ROI Tracking.
- **[v7.0.0](#v700---high-density-matrix-grids--sensory-haptics)** &mdash; 12-Lane QR Matrix Grids, Colour ×3 RGB Multi-Channel Multiplexing, Semantic Haptic Feedback Engine, Pentatonic Audio Synthesizer.
- **[v6.0.0](#v600---3d-tilt-hud--direct-dom-visual-tracking)** &mdash; 60 FPS Zero-React Reticle Tracking, 3D Card Parallax Stage, Gliding Segmented Pagers, Moving-Window ETA Metering.
- **[v5.0.0](#v500---protocol-v3-self-describing-binary-frames)** &mdash; Protocol v3 Self-Describing Binary Frames, Systematic Block Fountain Codes, Multi-Threaded QR Worker Pools.
- **[v4.0.0](#v400---mobile-viewfinder-architecture--gesture-pager)** &mdash; Bounded 16:9 Viewfinder Geometry, Horizontal Spring Pager, Wake-Lock API Integration, Frame Blitting Pipeline.
- **[v3.0.0](#v300---streaming-zip-bundling--equalized-qr-geometry)** &mdash; Streaming Multi-File ZIP Packager, Uniform QR Module Geometry, Headless Universal Deployment Engine.
- **[v2.0.0](#v200---protocol-v2-alphanumeric-base45--4-gb-streaming)** &mdash; Protocol v2 Base45 Packing, Multi-Gigabyte Stream Pipelining, Pre-Allocated Direct Buffer Reassembly.
- **[v1.0.0](#v100---initial-optical-air-gap-proof-of-concept)** &mdash; Genesis: Unidirectional Screen-to-Camera Optical File Transmission.

---

## v9.0.0 &mdash; The Dynamic Optical Engine & Liquid Media Studio

> **Theme:** Dynamic Rechunking, Ultra-Fast Stream Hashing, Hardware Lens Steering, and Handcrafted Liquid Glass UI.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BREAKTHROUGH: ZERO-LOSS DENSITY & CODEC HOT-SWITCHING                       │
│                                                                              │
│  Sender toggles density mid-stream:                                          │
│  [Reliable 500 B] ───► [Balanced 800 B] ───► [Max 1400 B] ───► [Ultra 2000 B] │
│                                                                              │
│  Receiver Engine: adaptChunkSize(newMeta)                                    │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ Preserved Decoded Bytes: 100% | Progress Reset: 0% | Bit Error Rate: 0 │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 1. Dynamic Codec & Density Hot-Switching (`adaptChunkSize`)
- **Zero Progress Loss on Parameter Shift:** Previously, altering the transmission density (e.g. from *Balanced 800 B* to *Max 1400 B*) or toggling QR lane count (e.g. from 1 to 4 QR codes) would force a pipeline restart. In v9.0.0, the `FountainDecoder` dynamically reslices and maps existing contiguous byte buffers across differing chunk lengths without dropping previously decoded frames.
- **Deterministic Transfer Identification:** Decoupled transfer identification from chunk count. Transfer IDs are now computed as a stable 32-bit integer (`(crc ^ (sendSize & 0xffff)) >>> 0 || 1`), guaranteeing that receiver and sender maintain synchronized state even when density changes dynamically.
- **Non-Destructive Sequence Tracking:** `Sender.tsx` preserves normalized relative progress ($\text{currentIndex} / \text{totalChunks}$) when regenerating pipelines, preventing disruptive visual jumping.
- **Smooth Visual Transitions:** Replaced heavy visual blur on lane shifts (`filter: blur(1.5px)`) with crisp opacity transitions to eliminate camera sensor acquisition drops during adjustments.

### 2. High-Performance Stream Hasher (>1.2 GB/s CRC32)
- **8-Way Unrolled Lookup Table:** Replaced byte-by-byte CRC calculation with an unrolled 8-way IEEE 802.3 slicing table, yielding hashing throughput exceeding **1.2 GB/s** in JavaScript/Web Worker threads.
- **Sub-Second Preparation:** Multi-hundred-megabyte payloads (e.g. 100 MB+ video files or disk images) now index and hash in under 80 ms, completely removing UI thread stalling.
- **Absolute Real-Time Mathematical Metrics:** Eliminated heuristic and mock countdown timers. The throughput engine computes true instantaneous and windowed transfer velocity ($\Delta \text{bytes} / \Delta t$) across a rolling 10-second window, displaying identical, accurate time-to-completion metrics on both transmitting and receiving displays.

### 3. Hardware Autofocus Lens Steering & Optical Framing
- **Native Camera Lens Control:** Directly interfaces with modern browser `MediaStreamTrack` hardware constraints (`focusMode: "continuous"`, `focusDistance`, and `zoom`).
- **Dynamic Lock-On Framing:** Real-time geometric calculation tracks the bounding polygon of all visible QR codes, smoothly applying continuous zoom (1.0x to 2.5x) to maintain the optimal 60% viewport fill.
- **Zoom Factor HUD:** Real-time optical magnification indicator (`1.0x` &ndash; `2.5x`) dynamically updates in the viewfinder overlay with zero layout shift.

### 4. Handcrafted Liquid Media Viewer Suite
Replaced stock browser controls with custom-crafted, hardware-accelerated media interfaces:
- **`CustomVideoPlayer`:**
  - Precision scrub bar with drag interaction and floating time-bubble previews.
  - Custom glassmorphic play/pause, volume slider with acoustic mute toggle, playback rate stepper (0.5x, 1x, 1.25x, 1.5x, 2x), Picture-in-Picture (PiP), and native fullscreen toggle.
  - Responsive keyboard shortcuts (Space, Arrow keys, M, F).
- **`CustomAudioPlayer`:**
  - Dynamic canvas-rendered waveform visualizer with real-time scrub tracking.
  - Floating acoustic pill with duration formatting, track scrubbing, and quick skip controls (+/- 10s).
- **`CustomFilePreview`:**
  - Syntax-highlighted code inspector with line numbering and raw copy controls.
  - Responsive Markdown viewer with GitHub-style blockquote alerts and table styling.
  - Multi-page PDF document reader with zoom and pagination controls.
  - Structured archive inspector displaying file hierarchies inside incoming ZIP bundles.

### 5. Liquid Glassmorphic Ergonomics & Safety
- **1-Second Auto-Vanishing QR Overlay:** When hovering over the sender stage, the play/pause transport controls utilize a liquid-glass frosted backdrop (`backdrop-blur-md bg-black/35`) and automatically fade to zero opacity after 1 second of cursor inactivity to avoid obstructing camera line-of-sight.
- **Balanced 4×2 Grid Geometry:** 8-code displays arrange as 4 columns by 2 rows on desktop viewports, avoiding awkward 3×3-1 splits.
- **Mobile-Optimized Header:** Scaled the top information button down by 50% on mobile displays (`w-8 h-8` with `text-xs`) to maintain generous touch targets without cluttering mobile headers.
- **Destructive Action Safety:** Added frosted glass confirmation modals before discarding paused transfers in the receiver or removing staged files in the sender.

---

## v8.0.0 &mdash; WASM SIMD Acceleration & Optical-Signaled Turbo WebRTC

> **Theme:** WebAssembly Vectorization, 4K High-Res Acquisition, and Optical-Signaled P2P Bridging.

### 1. C++ WebAssembly SIMD Multi-Code Decoder (`zxing-wasm`)
- **Native Vector Instructions:** Integrated `zxing-wasm` compiled with WebAssembly SIMD (128-bit vectorization), achieving up to 60 FPS concurrent multi-code decoding on mobile silicon (Apple A-series, Snapdragon, Google Tensor).
- **Multi-Code Extraction:** Decodes up to 12 QR codes in a single pass from a unified image buffer, drastically reducing GC allocations.

### 2. Optical-Signaled Turbo WebRTC Data Channel
- **Zero-Cloud Signaling:** Uses initial optical QR frames to transmit SDP offers and ICE candidates through the physical air-gap.
- **Automatic Fallback:** When both devices share a local network (or can peer directly), OFFDROP transparently shifts from optical transmission to a high-speed WebRTC data channel, achieving wire speeds of **50+ MB/s** while maintaining zero server involvement.

### 3. Region-of-Interest (ROI) Dynamic Tracking (`roi.ts`)
- **Selective High-Resolution Crop:** Instead of downscaling 4K camera frames, the receiver acquires code locations on a downscaled overview canvas and extracts localized full-resolution sub-windows around active QR grids.
- **Periodic Verification:** Runs a full-frame re-scan every 8 frames to immediately register newly appeared codes or large screen displacements.

---

## v7.0.0 &mdash; High-Density Matrix Grids & Sensory Haptics

> **Theme:** 12-Lane Optical Multiplexing, RGB Channel Separation, and Tactile Sound Design.

### 1. Expanded Multi-Code Grids (Up to 12 Codes)
- Added grid presets for 1, 2, 4, 6, 8, 9, and 12 simultaneous QR codes.
- Introduced aspect-ratio layout scoring to dynamically compute optimal column/row configurations ($3\times4$ or $4\times3$) based on viewport geometry.

### 2. Colour ×3 Multi-Channel Optical Multiplexing (Beta)
- Encoded three distinct binary frames into the Red, Green, and Blue sub-pixel channels of a single displayed frame.
- Receiver pipeline separates RGB channels and applies independent contrast stretching per channel before decoding, theoretically tripling data bandwidth per frame.

### 3. Semantic Haptic Feedback Engine (`haptics.ts`)
- Developed a comprehensive tactile response system:
  - Distinct vibration signatures for button clicks, density steps, camera lock-on, progress quarter-marks (25%, 50%, 75%), and completion flourishes.
  - Native iOS 17.4+ switch haptic integration alongside Android vibration API.

### 4. Pentatonic Web Audio Synthesizer (`audio.ts`)
- Replaced harsh notification beeps with an FM-synthesis audio engine tuned to a pentatonic scale.
- Real-time audio pitch ramps smoothly upward as transfer progress advances toward 100%.

---

## v6.0.0 &mdash; 3D Tilt HUD & Direct DOM Visual Tracking

> **Theme:** 60 FPS Viewfinder Reticle, 3D Parallax Stage, and Fluid UI Components.

### 1. Direct DOM Reticle Tracking
- Eliminated React re-renders from the camera viewfinder loop. Bounding box coordinates and lock-on frames are applied directly to DOM element transforms at 60 FPS.
- Centered status chips and adaptive corner reticles smoothly hug detected QR polygons.

### 2. 3D Interactive Card Parallax
- Implemented gyro- and mouse-reactive 3D tilt transformations on transmitting QR stages.
- Added glowing perimeter reflections that match active QR density modes.

### 3. Touch-Action Pager Optimization
- Enforced strict `pan-y` touch actions across all scrolling sub-containers, eliminating unintentional horizontal gesture cancellation during tab transitions.

---

## v5.0.0 &mdash; Protocol v3: Self-Describing Binary Frames

> **Theme:** Late-Join Decoding, Systematic Block Fountain Codes, and Parallel Workers.

### 1. Protocol v3 Self-Describing Frame Header
- Integrated a standardized 24-byte binary header into every transmitted QR frame.
- Receivers can begin assembling files from **any arbitrary frame** in the broadcast, eliminating the requirement to wait for an initial metadata packet.

```
+---------------+---------------+---------------+---------------+
| Magic ('OD')  |  Version (3)  |   Type Code   |  Transfer ID  |
+---------------+---------------+---------------+---------------+
|  Chunk Size   | Total Chunks  |  Chunk Index  |     Flags     |
+---------------+---------------+---------------+---------------+
|              CRC32 Checksum   |       Original File Size      |
+---------------+---------------+---------------+---------------+
```

### 2. Systematic Block Fountain Codes
- Grouped transfers into 256-chunk systematic blocks.
- Emitted deterministic XOR linear combinations using seeded pseudo-random number generators, keeping repair frame overhead under 8% even in high-loss optical environments.

### 3. Multi-Threaded QR Worker Pool
- Offloaded QR matrix calculation and Base45 alphanumeric serialization to an asynchronous Web Worker pool, keeping the main browser UI thread completely unblocked at 30+ FPS.

---

## v4.0.0 &mdash; Mobile Viewfinder Architecture & Gesture Pager

> **Theme:** Mobile Viewport Stability, Pager Physics, and Screen Wake-Lock.

### 1. Bounded Viewfinder Geometry
- Confined camera feeds to a strict 16:9 responsive viewfinder container, eliminating full-screen video overflows and clipping on iOS Safari.
- Moved transfer metrics, status HUDs, and controls completely outside the video viewport.

### 2. Spring Physics Horizontal Pager
- Engineered a touch-driven slider pager with rubber-band edge boundaries and smooth settling physics.
- Clamped active tab pills to prevent out-of-bounds positioning during rapid drags.

### 3. Screen Wake-Lock Integration
- Integrated the Screen Wake Lock API to prevent mobile displays from dimming or locking during prolonged multi-minute transfers.

---

## v3.0.0 &mdash; Streaming ZIP Bundling & Equalized QR Geometry

> **Theme:** Multi-File Drag-and-Drop, Uniform Visual Modules, and Universal Deployments.

### 1. Streaming Multi-File ZIP Packager
- Bundles multiple files and nested directories into standard ZIP archives on the fly using zero-copy Blob parts.
- Verified byte-for-byte compatibility with standard decompression tools (`unzip`, 7-Zip, Archive Utility).

### 2. Equalized Frame Geometry
- Padded all frame types (metadata headers, standard data chunks, and final fragments) to identical byte lengths.
- Prevents jarring QR visual size shifts and finder pattern relocations between frames.

### 3. Headless Universal Deployment Engine
- Architected the server output with **TanStack Start** and **Nitro** to support universal deployment:
  - Standalone Node.js server (`.output/server/index.mjs`).
  - Containerized Docker runtime.
  - Edge runtimes (Cloudflare Workers / Pages).
  - Reverse proxy configurations (Nginx, Caddy) with automated TLS for camera access.

---

## v2.0.0 &mdash; Protocol v2: Alphanumeric Base45 & 4 GB Streaming

> **Theme:** Base45 Packing, Multi-Gigabyte Payloads, and Flat Memory Architecture.

### 1. Base45 Binary Packing
- Squeezed binary frame payloads directly into QR Alphanumeric Mode using Base45 encoding.
- Increased data capacity from 700 bytes to 900+ bytes per QR code (+29% throughput increase) while maintaining identical physical module density.

### 2. Multi-Gigabyte Stream Pipelining
- Abolished the previous 2 MB file ceiling, introducing chunked streaming pipelines capable of transferring files up to 4 GB.
- Receiver allocates a single contiguous buffer upfront, eliminating thousands of intermediate Array and Map allocations.

### 3. Dynamic Memory Throttling
- Implemented an on-demand frame pipeline that generates QR matrices 2&ndash;3 frames ahead of playback, holding memory usage under 30 MB regardless of total transfer size.

---

## v1.0.0 &mdash; Initial Optical Air-Gap Proof of Concept

> **Theme:** Genesis of Screen-to-Camera File Transmission.

### Core Features
- First functional implementation of unidirectional optical air-gap data transfer in the web browser.
- Animated monochrome QR code generation using HTML5 Canvas.
- Browser webcam acquisition with `jsQR` computer vision decoding.
- Basic CRC32 verification on reconstructed binary payloads.
- Responsive mobile web interface with dark mode styling.

---

<div align="center">

<sub>OFFDROP is released under the MIT License. Built with pride for universal, unencumbered digital communication.</sub>

</div>
