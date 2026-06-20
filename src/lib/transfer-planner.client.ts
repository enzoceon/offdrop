import { buildSequence, planFile, type Slot } from "./qr-protocol";

export type PlannedTransfer = {
  id: string;
  totalData: number;
  crc: number;
  slots: Slot[];
};

type WorkerResponse =
  | ({ ok: true } & PlannedTransfer)
  | { ok: false; error: string };

export function planTransferInWorker(file: File, bytes: Uint8Array): Promise<PlannedTransfer> {
  if (typeof Worker === "undefined") {
    const plan = planFile(bytes, file.name, file.type, file.size);
    return Promise.resolve({
      id: plan.id,
      totalData: plan.total,
      crc: plan.crc,
      slots: buildSequence(plan),
    });
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./transfer-planner.worker.ts", import.meta.url), {
      type: "module",
    });
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("Transfer planning timed out."));
    }, 15000);

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      window.clearTimeout(timer);
      worker.terminate();
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "Transfer worker failed."));
    };

    const copy = bytes.slice();
    worker.postMessage(
      { bytes: copy.buffer, name: file.name, mime: file.type, size: file.size },
      [copy.buffer],
    );
  });
}