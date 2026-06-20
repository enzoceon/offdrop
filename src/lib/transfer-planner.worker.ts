import { buildSequence, planFile } from "./qr-protocol";

type PlanRequest = {
  bytes: ArrayBuffer;
  name: string;
  mime: string;
  size: number;
};

self.onmessage = (event: MessageEvent<PlanRequest>) => {
  try {
    const { bytes, name, mime, size } = event.data;
    const plan = planFile(new Uint8Array(bytes), name, mime, size);
    self.postMessage({
      ok: true,
      id: plan.id,
      totalData: plan.total,
      crc: plan.crc,
      slots: buildSequence(plan),
    });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : "Transfer planning failed.",
    });
  }
};