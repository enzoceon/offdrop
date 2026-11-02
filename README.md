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

QR streaming is bound by camera pixels, not CPU. Rough ceilings (payload per QR × frames per second):

| Density  | Bytes / QR | @ 8 fps  | @ 15 fps | @ 30 fps |
| -------- | ---------- | -------- | -------- | -------- |
| Reliable | 600        | 4.7 KB/s | 8.8 KB/s | 17.6 KB/s |
| Balanced | 900        | 7.0 KB/s | 13 KB/s  | 26 KB/s  |
| Dense    | 1400       | 11 KB/s  | 21 KB/s  | 41 KB/s  |
| Max      | 2000       | 16 KB/s  | 29 KB/s  | 59 KB/s  |

A 100 MB file therefore takes ~30–60+ minutes at best over QR. The app helps: compression (documents, text,
uncompressed media can shrink dramatically), batch bundling, screen wake-lock on both devices, pause/resume on the
receiver, and repair frames so a shaky camera costs ~10% extra instead of a full replay.

See `CHANGES.md` for the technical history.

# Lockfile note: run `bun install` (or `npm install`) once locally and commit the generated lockfile.
