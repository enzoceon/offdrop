import type { FrameMeta, StreamPlan } from "./qr-protocol";

const BROADCAST_NAME = "offdrop:turbo";
const BUFFER_HIGH_WATER = 4 * 1024 * 1024; // 4 MB backpressure threshold

export interface TurboSenderCallbacks {
  onProgress?: (sentChunks: number, totalChunks: number, bytesSent: number, rate: number) => void;
  onAck?: () => void;
}

export interface TurboSenderHandle {
  dispose: () => void;
}

export interface TurboReceiverHandle {
  dispose: () => void;
  sendAck?: () => void;
}

const activeSenders = new Map<number, { plan: StreamPlan; blob: Blob }>();

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Registers an active sender. Listens for local BroadcastChannel pulls and
 * establishes zero-config local WebRTC peer data channels via /api/signal.
 */
export function registerTurboSender(
  plan: StreamPlan,
  blob: Blob,
  callbacks?: TurboSenderCallbacks,
): TurboSenderHandle {
  activeSenders.set(plan.id, { plan, blob });
  let disposed = false;
  let bc: BroadcastChannel | null = null;
  let pc: RTCPeerConnection | null = null;
  let pollTimer: number | null = null;

  // 1. BroadcastChannel for same-device/multi-tab instantaneous transfer
  if (typeof BroadcastChannel !== "undefined") {
    try {
      bc = new BroadcastChannel(BROADCAST_NAME);
      bc.onmessage = async (event: MessageEvent) => {
        if (disposed) return;
        const data = event.data;
        if (data?.type === "pull" && data.id === plan.id) {
          await streamToBroadcast(bc!, plan, blob, () => disposed, callbacks?.onProgress);
        } else if (data?.type === "ack" && data.id === plan.id) {
          callbacks?.onAck?.();
        }
      };
      // Announce availability
      bc.postMessage({
        type: "announce",
        id: plan.id,
        name: plan.name,
        mime: plan.mime,
        size: plan.size,
        origSize: plan.origSize,
        chunk: plan.chunk,
        total: plan.total,
      });
    } catch {
      bc = null;
    }
  }

  // 2. WebRTC data channel for local network transfer
  if (typeof RTCPeerConnection !== "undefined") {
    void (async () => {
      try {
        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const dc = pc.createDataChannel("offdrop_turbo", { ordered: true });
        dc.binaryType = "arraybuffer";
        dc.bufferedAmountLowThreshold = 512 * 1024;

        dc.onmessage = (event: MessageEvent) => {
          if (disposed) return;
          if (typeof event.data === "string") {
            try {
              const data = JSON.parse(event.data);
              if (data?.type === "ack" && data.id === plan.id) {
                callbacks?.onAck?.();
              }
            } catch {}
          }
        };

        dc.onopen = async () => {
          if (disposed) return;
          dc.send(
            JSON.stringify({
              type: "meta",
              id: plan.id,
              name: plan.name,
              mime: plan.mime,
            }),
          );
          await streamToDataChannel(dc, plan, blob, () => disposed, callbacks?.onProgress);
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Rapid ICE gathering: host candidates are ready almost immediately (< 100ms)
        await new Promise<void>((resolve) => {
          if (!pc || pc.iceGatheringState === "complete") {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 350); // fast 350ms cap so local transfer starts immediately
          const check = () => {
            if (pc?.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", check);
              clearTimeout(timer);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", check);
        });

        if (disposed) return;

        // Post offer to signaling endpoint
        await fetch("/api/signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: plan.id, type: "offer", sdp: pc.localDescription }),
        }).catch(() => {});

        // Continually poll for answer while sender is active (rapid 150ms initial polling)
        let attempts = 0;
        const pollAnswer = async () => {
          if (disposed || !pc || pc.connectionState === "connected" || attempts++ > 900) return;
          try {
            const res = await fetch(`/api/signal?id=${plan.id}&type=answer`);
            if (res.ok) {
              const data = (await res.json()) as { found: boolean; sdp: RTCSessionDescriptionInit };
              if (data.found && data.sdp && pc.signalingState === "have-local-offer") {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                return;
              }
            }
          } catch {
            // Offline / signaling unavailable
          }
          if (!disposed) {
            const delay = attempts < 15 ? 150 : 800;
            pollTimer = window.setTimeout(pollAnswer, delay);
          }
        };
        pollTimer = window.setTimeout(pollAnswer, 150);
      } catch {
        // WebRTC unavailable
      }
    })();
  }

  return {
    dispose: () => {
      disposed = true;
      activeSenders.delete(plan.id);
      if (pollTimer !== null) clearTimeout(pollTimer);
      try {
        bc?.close();
      } catch {}
      try {
        pc?.close();
      } catch {}
    },
  };
}

/**
 * Registers an active receiver. Attempts to accelerate chunk reception
 * through BroadcastChannel and local WebRTC.
 */
export function registerTurboReceiver(
  meta: FrameMeta,
  onChunk: (index: number, payload: Uint8Array) => void,
  onHeader?: (name: string, mime: string) => void,
): TurboReceiverHandle {
  let disposed = false;
  let bc: BroadcastChannel | null = null;
  let pc: RTCPeerConnection | null = null;

  let activeDc: RTCDataChannel | null = null;

  // 1. BroadcastChannel
  if (typeof BroadcastChannel !== "undefined") {
    try {
      bc = new BroadcastChannel(BROADCAST_NAME);
      bc.onmessage = (event: MessageEvent) => {
        if (disposed) return;
        const data = event.data;
        if (!data || data.id !== meta.id) return;
        if (data.type === "announce" && onHeader) {
          onHeader(data.name, data.mime);
        } else if (data.type === "chunk") {
          onChunk(data.index, new Uint8Array(data.payload));
        }
      };
      bc.postMessage({ type: "pull", id: meta.id });
    } catch {
      bc = null;
    }
  }

  // 2. WebRTC
  if (typeof RTCPeerConnection !== "undefined") {
    void (async () => {
      try {
        // Poll for offer from signaling endpoint (rapid initial polling)
        let offerSdp: RTCSessionDescriptionInit | null = null;
        for (let i = 0; i < 40 && !disposed; i++) {
          try {
            const res = await fetch(`/api/signal?id=${meta.id}&type=offer`);
            if (res.ok) {
              const data = (await res.json()) as { found: boolean; sdp: RTCSessionDescriptionInit };
              if (data.found && data.sdp) {
                offerSdp = data.sdp;
                break;
              }
            }
          } catch {}
          const delay = i < 8 ? 150 : 500;
          await new Promise((r) => setTimeout(r, delay));
        }

        if (disposed || !offerSdp) return;

        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        pc.ondatachannel = (e) => {
          const dc = e.channel;
          activeDc = dc;
          dc.binaryType = "arraybuffer";
          dc.onmessage = (event: MessageEvent) => {
            if (disposed) return;
            if (typeof event.data === "string") {
              try {
                const parsed = JSON.parse(event.data);
                if (parsed.type === "meta" && onHeader) {
                  onHeader(parsed.name, parsed.mime);
                }
              } catch {}
            } else if (event.data instanceof ArrayBuffer) {
              const buf = event.data;
              if (buf.byteLength >= 4) {
                const view = new DataView(buf);
                const index = view.getUint32(0, true);
                const payload = new Uint8Array(buf, 4);
                onChunk(index, payload);
              }
            }
          };
        };

        await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Gather all local candidates quickly before sending answer (350ms cap)
        await new Promise<void>((resolve) => {
          if (!pc || pc.iceGatheringState === "complete") {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 350);
          const check = () => {
            if (pc?.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", check);
              clearTimeout(timer);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", check);
        });

        if (disposed) return;

        await fetch("/api/signal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: meta.id, type: "answer", sdp: pc.localDescription }),
        }).catch(() => {});
      } catch {
        // WebRTC unavailable
      }
    })();
  }

  const sendAck = () => {
    try {
      bc?.postMessage({ type: "ack", id: meta.id });
    } catch {}
    try {
      if (activeDc?.readyState === "open") {
        activeDc.send(JSON.stringify({ type: "ack", id: meta.id }));
      }
    } catch {}
  };

  return {
    dispose: () => {
      disposed = true;
      try {
        bc?.close();
      } catch {}
      try {
        pc?.close();
      } catch {}
    },
    sendAck,
  };
}

async function streamToBroadcast(
  bc: BroadcastChannel,
  plan: StreamPlan,
  blob: Blob,
  isCancelled: () => boolean,
  onProgress?: (sentChunks: number, totalChunks: number, bytesSent: number, rate: number) => void,
) {
  let bytesSent = 0;
  const startTime = performance.now();
  const rawBytes = blob.size <= 256 * 1024 * 1024 ? new Uint8Array(await blob.arrayBuffer()) : null;

  for (let i = 0; i < plan.total; i++) {
    if (isCancelled()) break;
    const start = i * plan.chunk;
    const end = Math.min(plan.size, (i + 1) * plan.chunk);
    const chunkBytes = rawBytes ? rawBytes.subarray(start, end) : new Uint8Array(await blob.slice(start, end).arrayBuffer());
    bc.postMessage({
      type: "chunk",
      id: plan.id,
      index: i,
      payload: chunkBytes,
    });
    bytesSent += chunkBytes.byteLength;
    if (i % 64 === 0 || i === plan.total - 1) {
      const elapsed = Math.max(0.05, (performance.now() - startTime) / 1000);
      onProgress?.(i + 1, plan.total, bytesSent, bytesSent / elapsed);
    }
    // Yield smoothly every 128 chunks
    if (i % 128 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

async function streamToDataChannel(
  dc: RTCDataChannel,
  plan: StreamPlan,
  blob: Blob,
  isCancelled: () => boolean,
  onProgress?: (sentChunks: number, totalChunks: number, bytesSent: number, rate: number) => void,
) {
  let bytesSent = 0;
  const startTime = performance.now();
  const rawBytes = blob.size <= 256 * 1024 * 1024 ? new Uint8Array(await blob.arrayBuffer()) : null;

  for (let i = 0; i < plan.total; i++) {
    if (isCancelled() || dc.readyState !== "open") break;

    // Fast backpressure check
    if (dc.bufferedAmount > BUFFER_HIGH_WATER) {
      await new Promise<void>((resolve) => {
        const onLow = () => {
          dc.removeEventListener("bufferedamountlow", onLow);
          resolve();
        };
        dc.addEventListener("bufferedamountlow", onLow);
      });
    }

    const start = i * plan.chunk;
    const end = Math.min(plan.size, (i + 1) * plan.chunk);
    const chunkBytes = rawBytes ? rawBytes.subarray(start, end) : new Uint8Array(await blob.slice(start, end).arrayBuffer());

    const packet = new Uint8Array(4 + chunkBytes.byteLength);
    new DataView(packet.buffer).setUint32(0, i, true);
    packet.set(chunkBytes, 4);

    try {
      dc.send(packet.buffer);
    } catch {
      break;
    }

    bytesSent += chunkBytes.byteLength;
    if (i % 256 === 0 || i === plan.total - 1) {
      const elapsed = Math.max(0.05, (performance.now() - startTime) / 1000);
      onProgress?.(i + 1, plan.total, bytesSent, bytesSent / elapsed);
      // Fast non-clamping cooperative scheduling: microtask tick, macrotask every 1024
      if (i % 1024 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      } else {
        await Promise.resolve();
      }
    }
  }
}
