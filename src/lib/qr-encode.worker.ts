/// <reference lib="webworker" />
import QRCode from "qrcode";

type EncodeRequest = {
  id: number;
  text: string;
  errorCorrectionLevel: "L" | "M";
  version: number;
};

self.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const { id, text, errorCorrectionLevel, version } = event.data;
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel, version });
    const size = qr.modules.size;
    const modules = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        modules[row * size + column] = qr.modules.get(row, column) ? 1 : 0;
      }
    }
    (self as unknown as Worker).postMessage({ id, size, modules: modules.buffer }, [
      modules.buffer,
    ]);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id,
      error: error instanceof Error ? error.message : "QR encoding failed.",
    });
  }
};
