# OFFDROP

<div align="center">

<img src="docs/assets/offdrop-logo.svg" width="180" alt="OFFDROP Logo" />

<br />
<br />

# MOVE FILES.<br />NOT THROUGH THE INTERNET.

### A new way to transfer files. Powered by light.

Send files between devices using animated QR codes. No cloud storage. No accounts. No transfer servers. No internet connection between devices.

<br />

<a href="YOUR_LIVE_URL"><img src="https://img.shields.io/badge/EXPLORE_OFFDROP-6366F1?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Explore OFFDROP" /></a>
<a href="#how-it-works"><img src="https://img.shields.io/badge/HOW_IT_WORKS-111827?style=for-the-badge&logo=readme&logoColor=white" alt="How it works" /></a>
<a href="#getting-started"><img src="https://img.shields.io/badge/DEVELOPMENT-06B6D4?style=for-the-badge&logo=github&logoColor=white" alt="Development" /></a>

<br />
<br />

<img src="docs/assets/offdrop-hero.gif" width="100%" alt="OFFDROP animated file transfer demonstration" />

<br />

**YOUR SCREEN IS THE SENDER. YOUR CAMERA IS THE RECEIVER.**

<br />

<img src="https://img.shields.io/badge/100%25-Offline-06B6D4?style=flat-square" />
<img src="https://img.shields.io/badge/Transfer-Optical-8B5CF6?style=flat-square" />
<img src="https://img.shields.io/badge/Recovery-Fountain_Code-A855F7?style=flat-square" />
<img src="https://img.shields.io/badge/Runtime-Browser-22C55E?style=flat-square" />

</div>

---

<div align="center">

# THE INTERNET IS OPTIONAL.

**File sharing shouldn't require an intermediary.**

</div>

Traditional file-sharing systems rely on infrastructure: cloud services, accounts, servers, networks and external dependencies.

OFFDROP takes a different approach.

It transforms file data into animated QR codes, transmitting information directly through a display and reconstructing it using another device's camera.

No pairing. No accounts. No transfer infrastructure.

Just light.

<div align="center">

<img src="docs/assets/offdrop-transmission.gif" width="90%" alt="Visualisation of optical file transmission" />

</div>

---

# THE EXPERIENCE

<div align="center">

<table>
<tr>
<td align="center" width="50%">

<img src="docs/assets/sender.png" width="100%" alt="OFFDROP sender interface" />

### 01. TRANSMIT

**Choose. Prepare. Play.**

Select one file or bundle multiple files. OFFDROP prepares the data and turns it into an animated QR stream.

</td>
<td align="center" width="50%">

<img src="docs/assets/receiver.png" width="100%" alt="OFFDROP receiver interface" />

### 02. RECEIVE

**Scan. Reconstruct. Done.**

Point another device's camera at the sender. OFFDROP reconstructs the original data as frames arrive.

</td>
</tr>
</table>

</div>

---

# ENGINEERED DIFFERENTLY.

Not just another QR generator.

OFFDROP is built around the realities of optical transmission: dropped frames, imperfect cameras, variable lighting and limited bandwidth.

<table>
<tr>
<td width="50%" valign="top">

### <img src="docs/assets/icons/qr.svg" width="24" /> MULTI-CODE TRANSMISSION

Display multiple QR codes simultaneously to increase the amount of data transmitted per frame.

</td>
<td width="50%" valign="top">

### <img src="docs/assets/icons/recovery.svg" width="24" /> FOUNTAIN-STYLE RECOVERY

Recover missing data using repair frames instead of requiring a complete retransmission.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### <img src="docs/assets/icons/compression.svg" width="24" /> AUTOMATIC COMPRESSION

Deflate compressible content when doing so reduces the payload.

</td>
<td width="50%" valign="top">

### <img src="docs/assets/icons/streaming.svg" width="24" /> LARGE FILE STREAMING

Process file data incrementally rather than requiring the entire encoded transfer in memory.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### <img src="docs/assets/icons/integrity.svg" width="24" /> INTEGRITY VERIFICATION

Verify reconstructed data using checksums before completing a transfer.

</td>
<td width="50%" valign="top">

### <img src="docs/assets/icons/bundle.svg" width="24" /> MULTI-FILE BUNDLING

Transfer multiple selected files together in a ZIP archive.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### <img src="docs/assets/icons/pause.svg" width="24" /> PAUSE & RESUME

Pause an ongoing transfer and continue when you're ready.

</td>
<td width="50%" valign="top">

### <img src="docs/assets/icons/wakelock.svg" width="24" /> SCREEN WAKE LOCK

Help prevent the sender's display from sleeping during transmission.

</td>
</tr>
</table>

---

# HOW IT WORKS

<div align="center">

<img src="docs/assets/architecture.svg" width="100%" alt="OFFDROP optical transfer architecture" />

### FROM FILE TO LIGHT. FROM LIGHT BACK TO FILE.

</div>

The transfer pipeline:

```text
SENDER
  |
  v
FILE SELECTION
  |
  v
FILE PREPARATION
  |
  v
COMPRESSION
  |
  v
DATA ENCODING
  |
  v
QR GENERATION
  |
  v
ANIMATED TRANSMISSION
  |
  v
========================
      OPTICAL CHANNEL
========================
  |
  v
CAMERA CAPTURE
  |
  v
FRAME DECODING
  |
  v
DATA RECONSTRUCTION
  |
  v
LOSS RECOVERY
  |
  v
CHECKSUM VERIFICATION
  |
  v
ORIGINAL FILE
  |
  v
RECEIVER
```

### THE INTERESTING PART: LOST FRAMES.

A conventional sequential transfer can fail when required pieces of data never arrive.

OFFDROP uses fountain-style repair frames to make the transfer more resilient.

Instead of depending exclusively on the original sequence, the receiver collects useful encoded data and repair information until reconstruction is possible.

The receiver can also begin listening from the first frame it encounters. It doesn't need to wait for a new transfer to start.

<div align="center">

<img src="docs/assets/fountain-recovery.gif" width="85%" alt="Animated explanation of fountain-style recovery" />

</div>

---

# PERFORMANCE, VISUALISED.

The optical channel determines throughput.

More payload per QR code and more simultaneous codes increase the theoretical transmission rate.

### Theoretical throughput

| Density | Payload / QR | 1 Code | 4 Codes | 6 Codes |
|:---|---:|---:|---:|---:|
| 🟢 Reliable | 500 B | 7.3 KB/s | 29 KB/s | 44 KB/s |
| 🔵 Balanced | 800 B | 11.7 KB/s | 47 KB/s | 70 KB/s |
| 🟣 Dense | 1,100 B | 16 KB/s | 64 KB/s | 97 KB/s |
| 🟠 Max | 1,400 B | 20 KB/s | 82 KB/s | 123 KB/s |
| 🔴 Ultra | 2,000 B | 29 KB/s | 117 KB/s | 176 KB/s |

<div align="center">

### MORE CODES. MORE DATA. SAME OPTICAL CHANNEL.

</div>

These are theoretical payload estimates at 15 frames per second, not guaranteed real-world speeds.

Actual performance depends on camera resolution, focus, display size, lighting, QR density and decoding reliability.

A 100 MB transfer may take approximately 14–20 minutes under favourable conditions.

OFFDROP also includes compression, multi-code transmission, repair frames and pause/resume to improve the experience.

---

# BUILT FOR THE REAL WORLD.

<div align="center">

| Environment | Consideration |
|:---|:---|
| Large displays | More room for readable QR codes |
| Mobile cameras | Autofocus and exposure affect decoding |
| Bright environments | Screen reflections can reduce readability |
| Dense QR codes | Require better optical resolution |
| Long transfers | Both devices must remain available |
| Large payloads | Streaming reduces memory pressure |

</div>

---

# DEVELOPMENT

Want to explore the implementation, improve the protocol or build something on top of OFFDROP?

You're welcome.

### Requirements

- Bun or Node.js
- Node.js 22 or later for the test suite
- A modern browser for camera functionality

### Clone the repository

```bash
git clone https://github.com/enzoceon/offdrop.git

cd offdrop

bun install
```

### Start development

```bash
bun run dev
```

### Run the test suite

```bash
bun run test
```

### Type checking

```bash
bun run typecheck
```

### Production build

```bash
bun run build
```

---

# DEPLOYMENT

OFFDROP can be deployed through Vercel using the existing Nitro configuration.

1. Import the repository into Vercel.
2. Keep the repository's deployment configuration.
3. Use `bun run build` or `npm run build`.
4. Deploy.

Nitro detects Vercel at build time and generates the appropriate deployment output.

For alternative hosting environments:

```bash
NITRO_PRESET=node-server bun run build
```

```bash
NITRO_PRESET=cloudflare-module bun run build
```

Camera access requires a secure context, typically HTTPS or localhost.

---

# UNDER THE HOOD

OFFDROP is built using modern web technologies.

| Technology | Purpose |
|:---|:---|
| TypeScript | Application and protocol implementation |
| React | User interface |
| TanStack Start | Application framework |
| Vite | Development and build tooling |
| Nitro | Deployment infrastructure |
| IndexedDB | Browser-side persistent storage |

The architecture separates the transfer protocol from the user interface, allowing encoding, decoding, compression, recovery and reconstruction to be tested independently.

---

# DESIGN PHILOSOPHY

**No unnecessary infrastructure.**

Transfers should not depend on a remote service.

**Resilience over assumptions.**

Frames will be missed. Cameras will struggle. The protocol must account for it.

**Privacy by architecture.**

The transfer does not require uploading file contents to a cloud server.

**Engineering over marketing.**

Realistic benchmarks, explicit limitations and reproducible tests matter.

**Simple on the surface. Powerful underneath.**

The user should never need to understand fountain codes to send a file.

---

# LIMITATIONS

OFFDROP uses optical transmission, which has inherent constraints.

- Throughput is lower than typical local network transfers.
- Camera focus and display resolution affect performance.
- High-density QR configurations require suitable hardware.
- Lighting, glare and movement can interfere with capture.
- Large transfers may take considerable time.
- Browser support and camera permissions vary.

OFFDROP is designed for situations where direct, infrastructure-free transfer is more important than maximum throughput.

---

# CONTRIBUTE

OFFDROP is open source, and there's plenty of room to make it better.

Areas where contributions can make a difference:

- QR encoding and decoding performance.
- Fountain-code recovery efficiency.
- Camera compatibility.
- Memory efficiency for large transfers.
- Compression and protocol optimisations.
- Browser compatibility.
- Accessibility and interface improvements.
- Automated testing across devices.

Open an issue to discuss substantial changes before submitting a pull request.

Every improvement to reliability makes OFFDROP more useful.

---

# LICENSE

OFFDROP is distributed under the MIT License. See [LICENSE](LICENSE) for details.

---

<div align="center">

<img src="docs/assets/offdrop-logo.svg" width="120" alt="OFFDROP" />

<br />

# THE WORLD IS CONNECTED.<br />YOUR FILES DON'T HAVE TO BE.

**OFFDROP**

Transfer through light.

<br />

<a href="#offdrop">BACK TO TOP ↑</a>

<br />
<br />

<sub>Built with curiosity. Engineered for independence.</sub>

</div>
