# OFFDROP

Offline file transfer over animated QR codes. No servers, no accounts, no internet between the two devices.

**Send** → pick one file or many (bundled into a zip) → press play. **Receive** → point the camera at the sender's screen.
Everything is checksum-verified, big files are streamed, compressible files are deflated automatically, and
dropped frames are repaired with fountain-style repair frames instead of replaying the whole file.

## Develop

```bash
bun install        # or npm install
bun run dev
bun run test       # protocol, loss-recovery and compression tests (Node >= 22)
bun run typecheck
bun run build
```

## Deploy to Vercel (via GitHub)

1. Push this repository to GitHub.
2. In Vercel: **Add New → Project → Import** the repo.
3. Leave the defaults (Framework Preset: *Other* is set by `vercel.json`; Build Command: `bun run build` / `npm run build`).
4. Deploy. Nitro detects Vercel at build time and emits the Vercel Build Output automatically, so there is no
   adapter to configure. Camera access requires HTTPS, which Vercel provides.

To target another host set `NITRO_PRESET` (e.g. `cloudflare-module`, `node-server`) at build time.

## How fast is it?

QR streaming is bound by what the receiving camera can resolve, not by CPU. Throughput =
payload per code x frames/s x codes on screen at once.

| Density  | Bytes / QR | 1 code @ 15 fps | 4 codes @ 15 fps | 6 codes @ 15 fps |
| -------- | ---------- | --------------- | ---------------- | ---------------- |
| Reliable | 500        | 7.3 KB/s        | 29 KB/s          | 44 KB/s          |
| Balanced | 800        | 11.7 KB/s       | 47 KB/s          | 70 KB/s          |
| Dense    | 1100       | 16 KB/s         | 64 KB/s          | 97 KB/s          |
| Max      | 1400       | 20 KB/s         | 82 KB/s          | 123 KB/s         |

Phone cameras usually capture 30 fps, so showing a new code more than ~15-30 times per second mostly just
drops frames; adding *codes per frame* (2x / 4x / 6x in fullscreen on a big screen) is what scales. A 100 MB file
is therefore roughly 14-20 minutes in the best realistic case (large sender screen, sharp receiver camera), not
seconds. The app helps: compression, multi-file bundling, screen wake-lock, pause/resume, repair frames, and a
receiver that starts from the very first frame it sees.

See `CHANGES.md` for the technical history.
