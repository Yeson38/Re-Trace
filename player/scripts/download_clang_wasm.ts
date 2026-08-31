/**
 * Phase 4 — Download Clang 17 WASM for browser C++ recording.
 *
 * Downloads clang.wasm and lld.wasm from WAPM CDN into public/assets/wasm/.
 * Run via: npm run download:clang-wasm
 */
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const CLANG_URL = "https://cdn.wapm.io/llvm/clang@17.0.6/clang.wasm";
const LLD_URL = "https://cdn.wapm.io/llvm/clang@17.0.6/lld.wasm";
const OUTPUT_DIR = join(process.cwd(), "public", "assets", "wasm");

async function downloadFile(url: string, outPath: string): Promise<number> {
  console.log(`Downloading ${url} ...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  await writeFile(outPath, buf);
  const kb = Math.round(buf.length / 1024);
  console.log(`  → ${outPath} (${kb} KB)`);
  return buf.length;
}

async function main(): Promise<void> {
  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }

  let total = 0;
  total += await downloadFile(CLANG_URL, join(OUTPUT_DIR, "clang.wasm"));
  total += await downloadFile(LLD_URL, join(OUTPUT_DIR, "lld.wasm"));

  // Write manifest
  const manifest = {
    version: "17.0.6",
    source: "wapm.io",
    files: ["clang.wasm", "lld.wasm"],
    totalBytes: total,
    downloadedAt: new Date().toISOString(),
  };
  await writeFile(
    join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  const mb = Math.round(total / 1024 / 1024);
  console.log(`\nDone! Total: ${mb} MB in ${OUTPUT_DIR}`);
}

main().catch((e) => {
  console.error("Download failed:", e);
  process.exit(1);
});
