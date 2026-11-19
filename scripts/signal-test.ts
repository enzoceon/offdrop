import { handleSignal } from "../src/lib/signal-store.ts";

const endpoint = "https://offdrop.test/api/signal";
const origin = "https://offdrop.test";

async function request(path: string, init?: RequestInit) {
  const response = await handleSignal(new Request(`${endpoint}${path}`, init));
  if (!response) throw new Error("signal endpoint did not handle request");
  return response;
}

async function post(id: number, type: "offer" | "answer" = "offer", sdp = "v=0\r\n") {
  return request("", {
    method: "POST",
    headers: { origin },
    body: JSON.stringify({ id, type, sdp: { type, sdp } }),
  });
}

{
  const id = 0x7ffffffe;
  const response = await post(id);
  if (!response.ok) throw new Error(`valid offer rejected: ${response.status}`);
  const received = await request(`?id=${id}&type=offer`);
  const data = (await received.json()) as { found: boolean; sdp: { type: string; sdp: string } };
  if (!data.found || data.sdp.type !== "offer" || data.sdp.sdp !== "v=0\r\n") {
    throw new Error("offer roundtrip failed");
  }
}

for (const [body, expectedStatus] of [
  [{ id: -1, type: "offer", sdp: { type: "offer", sdp: "v=0" } }, 400],
  [{ id: 12, type: "offer", sdp: { type: "answer", sdp: "v=0" } }, 400],
  [{ id: 13, type: "other", sdp: { type: "other", sdp: "v=0" } }, 400],
] as const) {
  const response = await request("", {
    method: "POST",
    headers: { origin },
    body: JSON.stringify(body),
  });
  if (response.status !== expectedStatus) {
    throw new Error(`invalid signal returned ${response.status}, expected ${expectedStatus}`);
  }
}

const oversized = await request("", {
  method: "POST",
  headers: { origin, "content-length": String(129 * 1024) },
  body: JSON.stringify({ id: 14, type: "offer", sdp: { type: "offer", sdp: "v=0" } }),
});
if (oversized.status !== 413) throw new Error("oversized signal body was not rejected");

const crossOrigin = await request("", {
  method: "POST",
  headers: { origin: "https://attacker.test" },
  body: JSON.stringify({ id: 15, type: "offer", sdp: { type: "offer", sdp: "v=0" } }),
});
if (crossOrigin.status !== 403) throw new Error("cross-origin signal request was not rejected");

for (let id = 1000; id < 1127; id++) {
  const response = await post(id);
  if (!response.ok) throw new Error(`signal store filled unexpectedly at ${id}`);
}
const fullStoreResponse = await post(1127);
if (fullStoreResponse.status !== 503) throw new Error("signal store capacity was not enforced");

console.log("ALL PASS (signal validation and limits)");
