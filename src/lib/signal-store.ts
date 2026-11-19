const SIGNAL_TTL_MS = 5 * 60 * 1000;
const MAX_SIGNAL_ENTRIES = 128;
const MAX_SIGNAL_BODY_BYTES = 128 * 1024;
const MAX_SDP_BYTES = 64 * 1024;

type SignalDescription = {
  type: "offer" | "answer";
  sdp: string;
};

type SignalEntry = {
  offer?: SignalDescription;
  answer?: SignalDescription;
  time: number;
};

const signalStore = new Map<number, SignalEntry>();

class SignalRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function isSignalId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new SignalRequestError("invalid content length", 400);
    }
    if (length > MAX_SIGNAL_BODY_BYTES) {
      throw new SignalRequestError("request body too large", 413);
    }
  }

  if (!req.body) throw new SignalRequestError("missing request body", 400);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SIGNAL_BODY_BYTES) {
        await reader.cancel();
        throw new SignalRequestError("request body too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SignalRequestError("invalid json", 400);
  }
}

function validSignalDescription(value: unknown, type: "offer" | "answer"): value is SignalDescription {
  if (!value || typeof value !== "object") return false;
  const description = value as { type?: unknown; sdp?: unknown };
  return (
    description.type === type &&
    typeof description.sdp === "string" &&
    new TextEncoder().encode(description.sdp).byteLength <= MAX_SDP_BYTES
  );
}

export async function handleSignal(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/signal") return null;

  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) {
    return jsonResponse({ error: "cross-origin requests are not allowed" }, 403);
  }

  const sameOriginHeaders = {
    "access-control-allow-origin": url.origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };

  const now = Date.now();
  for (const [id, entry] of signalStore) {
    if (now - entry.time > SIGNAL_TTL_MS) signalStore.delete(id);
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: sameOriginHeaders });
  }

  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object") {
        return jsonResponse({ error: "invalid request" }, 400, sameOriginHeaders);
      }

      const signal = body as { id?: unknown; type?: unknown; sdp?: unknown };
      if (!isSignalId(signal.id)) {
        return jsonResponse({ error: "invalid id" }, 400, sameOriginHeaders);
      }
      if (signal.type !== "offer" && signal.type !== "answer") {
        return jsonResponse({ error: "invalid signal type" }, 400, sameOriginHeaders);
      }
      if (!validSignalDescription(signal.sdp, signal.type)) {
        return jsonResponse({ error: "invalid session description" }, 400, sameOriginHeaders);
      }

      let entry = signalStore.get(signal.id);
      if (!entry) {
        if (signalStore.size >= MAX_SIGNAL_ENTRIES) {
          return jsonResponse({ error: "signaling capacity reached; retry later" }, 503, sameOriginHeaders);
        }
        entry = { time: now };
        signalStore.set(signal.id, entry);
      }
      entry.time = now;
      entry[signal.type] = signal.sdp;
      return jsonResponse({ ok: true }, 200, sameOriginHeaders);
    } catch (error) {
      if (error instanceof SignalRequestError) {
        return jsonResponse({ error: error.message }, error.status, sameOriginHeaders);
      }
      throw error;
    }
  }

  if (req.method === "GET") {
    const idValue = url.searchParams.get("id");
    const id = idValue === null ? NaN : Number(idValue);
    const type = url.searchParams.get("type");
    if (!isSignalId(id) || (type !== "offer" && type !== "answer")) {
      return jsonResponse({ error: "invalid id or signal type" }, 400, sameOriginHeaders);
    }
    const entry = signalStore.get(id);
    const description = entry?.[type];
    return jsonResponse(
      { found: Boolean(description), sdp: description ?? null },
      200,
      sameOriginHeaders,
    );
  }

  return jsonResponse({ error: "method not allowed" }, 405, {
    ...sameOriginHeaders,
    allow: "GET, POST, OPTIONS",
  });
}
