# OFFDROP

<div align="center">

**The internet isn't required to move a file.**

Transfer files between devices using nothing but light.

OFFDROP turns screens into transmitters and cameras into receivers, using animated QR codes to move data directly between devices. No cloud. No accounts. No transfer servers. No internet connection between devices.

[**Try OFFDROP**](#) · [How It Works](#how-it-works) · [Documentation](#technical-overview)

<br />

![OFFDROP](docs/assets/offdrop-demo.gif)

<br />

[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](#) 
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](#)
[![Offline](https://img.shields.io/badge/transfer-offline-black)](#)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

## Files should move freely.

Most file-sharing tools depend on something in between.

A server. A cloud account. A network. A third-party service.

OFFDROP removes that dependency.

Choose a file on one device. Display its animated QR stream. Scan it with another device. The data travels optically from one screen to another.

Two devices. Two cameras or displays. One direct transfer.

No infrastructure required.

## How it works

<div align="center">

**01 — SELECT**

Choose a file, or select multiple files to transfer together.

↓

**02 — TRANSMIT**

OFFDROP encodes the data into a continuous stream of animated QR codes.

↓

**03 — RECEIVE**

The receiving device scans the stream through its camera and reconstructs the original data.

↓

**04 — COMPLETE**

Missing data is recovered, integrity is verified, and the file is ready.

</div>

The sender and receiver do not need to communicate over a network. The receiver can begin from any point in the stream.

## Built for imperfect conditions.

Optical transfer is inherently unreliable. Screens refresh, cameras miss frames, autofocus takes time, and lighting is rarely perfect.

OFFDROP is designed around those realities.

| Capability | What it does |
|---|---|
| Multi-frame transmission | Distributes file data across animated QR codes |
| Multi-code transmission | Displays multiple QR codes simultaneously |
| Fountain-style recovery | Recovers missing data using repair frames |
| Automatic compression | Deflates compressible content |
| Streaming | Handles large files without requiring the entire encoded transfer in memory |
| Integrity verification | Checks reconstructed data using checksums |
| Multi-file transfers | Bundles multiple files into a ZIP archive |
| Pause and resume | Allows transfers to be paused and continued |
| Wake Lock | Helps prevent the sender's screen from sleeping |

## Transfer performance

OFFDROP is constrained by the optical channel, not simply by processing power.

Actual throughput depends on QR density, camera resolution, focus, display size, lighting, frame rate and the number of codes displayed simultaneously.

### Theoretical payload throughput

| QR density | Bytes / QR | 1 code | 4 codes | 6 codes |
|---|---:|---:|---:|---:|
| Reliable | 500 | 7.3 KB/s | 29 KB/s | 44 KB/s |
| Balanced | 800 | 11.7 KB/s | 47 KB/s | 70 KB/s |
| Dense | 1,100 | 16 KB/s | 64 KB/s | 97 KB/s |
| Max | 1,400 | 20 KB/s | 82 KB/s | 123 KB/s |
| Ultra | 2,000 | 29 KB/s | 117 KB/s | 176 KB/s |

*Estimates at 15 frames per second. These are theoretical payload rates, not guaranteed real-world transfer speeds.*

A 100 MB transfer can take approximately 14–20 minutes under favourable conditions. Real-world performance varies.

**The objective isn't to promise impossible speeds. It's to make offline file transfer reliable.**

## Designed around the browser.

OFFDROP runs in the browser and uses standard web platform capabilities wherever possible.

No native application is required for supported browser environments.

- Camera access through browser media APIs.
- Persistent local transfer state where supported.
- Browser-based encoding and decoding.
- No mandatory backend for device-to-device transfers.

Camera access requires a secure context, typically HTTPS or localhost.

## Technical overview

The transfer pipeline is designed around independent, recoverable data frames.

```text
                 SENDER
                   |
              File Selection
                   |
             File Preparation
                   |
             Compression
                   |
             Data Encoding
                   |
             QR Generation
                   |
          Animated QR Transmission
                   |
            OPTICAL CHANNEL
                   |
          Animated QR Reception
                   |
             Frame Decoding
                   |
           Data Reconstruction
                   |
            Loss Recovery
                   |
          Checksum Verification
                   |
              File Output
                   |
                RECEIVER
```

### Recovery instead of retransmission

Traditional sequential transfers depend on receiving every part in order.

OFFDROP uses fountain-style repair frames to make reconstruction resilient to missed frames.

The receiver collects enough useful data to reconstruct the original payload without requiring the sender to replay the entire transfer.

### Compression

Compressible files are automatically deflated when beneficial. Compression is not forced when it would increase the payload unnecessarily.

### Integrity

Reconstructed content is checksum-verified before completion.

## Getting started

### Requirements

- Bun or Node.js
- A modern browser
- Camera access on the receiving device

### Installation

```bash
git clone https://github.com/enzoceon/offdrop.git

cd offdrop

bun install
```

### Development

```bash
bun run dev
```

### Tests

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

## Deployment

OFFDROP can be deployed to Vercel.

1. Import the GitHub repository into Vercel.
2. Configure the build command as `bun run build` or `npm run build`.
3. Deploy using the repository's existing Vercel configuration.

Nitro detects the Vercel deployment environment and generates the appropriate output.

For other deployment targets, configure `NITRO_PRESET` at build time.

Examples:

```bash
NITRO_PRESET=node-server bun run build
NITRO_PRESET=cloudflare-module bun run build
```

## Design principles

OFFDROP is built around a few simple ideas:

- **No unnecessary infrastructure.** Device-to-device transfers should not require a transfer server.
- **Resilience over assumptions.** A camera will miss frames. The protocol should expect that.
- **Privacy by architecture.** File contents travel through the optical channel rather than a mandatory cloud service.
- **Practical engineering.** Large files, unreliable cameras and real browser limitations matter more than impressive demos.
- **Simplicity at the surface.** Sending a file should be easier than explaining how the protocol works.

## Limitations

OFFDROP is an optical transfer system, not a replacement for high-bandwidth network transfers.

- Transfer speeds are limited by display and camera capabilities.
- High-density QR codes require suitable screens and cameras.
- Poor lighting, reflections and motion can reduce reliability.
- Large transfers may take considerable time.
- Browser camera permissions and compatibility vary.
- Both devices need to remain positioned so the receiving camera can see the transmitting display.

## Contributing

OFFDROP is an engineering project, and contributions are welcome.

Whether you're improving decoding reliability, optimizing frame generation, strengthening recovery, fixing browser compatibility or improving the interface, contributions are valuable.

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Run the tests and type checker.
5. Open a pull request describing the changes.

Please include reproduction steps for bugs and relevant browser/device details for camera-related issues.

## License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">

### The simplest connection is sometimes no connection at all.

**OFFDROP**

Transfer through light.

[Back to top](#offdrop)

</div>
