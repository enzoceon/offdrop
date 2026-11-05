/// <reference lib="webworker" />
import { BlobSource } from "./blob-source";
import { buildColorFrame, buildFrame } from "./frame-core";
import type { StreamPlan } from "./qr-protocol";

type InitMsg = { type: "init"; plan: StreamPlan; blob: Blob; ec: "L" | "M"; color: boolean };
type BuildMsg = { type: "build"; seq: number };

let plan: StreamPlan | null = null;
let source: BlobSource | null = null;
let ec: "L" | "M" = "M";
let color = false;

self.onmessage = async (event: MessageEvent<InitMsg | BuildMsg>) => {
  const msg = event.data;
  if (msg.type === "init") {
    plan = msg.plan;
    ec = msg.ec;
    color = msg.color;
    source = new BlobSource(msg.blob, msg.plan.chunk);
    return;
  }
  if (!plan || !source) return;
  try {
    const frame = color ? await buildColorFrame(plan, source, msg.seq, ec) : await buildFrame(plan, source, msg.seq, ec);
    (self as unknown as Worker).postMessage({ type: "frame", frame }, [frame.pixels.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      type: "error",
      seq: msg.seq,
      message: error instanceof Error ? error.message : "Frame build failed",
    });
  }
};
