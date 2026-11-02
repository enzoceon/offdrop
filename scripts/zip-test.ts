// Builds a bundle and writes it to /tmp so Python's zipfile can verify it independently.
import { buildZip } from "../src/lib/zip-bundle.ts";
import { writeFileSync } from "node:fs";
const files = [
  new File([new TextEncoder().encode("hello world\n".repeat(1000))], "a.txt", { lastModified: Date.now() }),
  new File([new Uint8Array(300_000).map((_, i) => (i * 7) & 255)], "bin.dat"),
  new File([], "empty.txt"),
  new File(["ünïcödé"], "ünï cödé.txt"),
  new File(["dup"], "a.txt"),
];
const zip = await buildZip(files);
writeFileSync("/tmp/bundle.zip", Buffer.from(await zip.arrayBuffer()));
console.log("wrote", zip.name, zip.size);
