import puppeteer from "puppeteer-core";

const version = await fetch("http://127.0.0.1:9222/json/version").then(r => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl, protocolTimeout: 0 });
const page = await browser.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 30000 });

// Minimal C++ program - no retrace.h, just test compilation speed
const src = `int main() { return 0; }`;

const t0 = Date.now();
const result = await page.evaluate(async (s) => {
  const mod = await import("https://cdn.jsdelivr.net/npm/@wasmer/sdk@0.8.0/dist/index.mjs");
  await mod.init();
  const clang = await mod.Wasmer.fromRegistry("clang/clang");
  const project = new mod.Directory();
  await project.writeFile("test.cpp", s);
  const t1 = Date.now();
  const run = await clang.entrypoint.run({
    args: ["-O0", "-std=c++17", "-fno-exceptions", "-fno-rtti", "/test.cpp", "-o", "/test.wasm"],
    mount: { "/": project },
  });
  const out = await run.wait();
  const t2 = Date.now();
  return { ok: out.ok, code: out.code, compileMs: t2 - t1, stderr: out.stderr };
}, src);
const total = Date.now() - t0;
console.log(`Total: ${total}ms, compile: ${result.compileMs}ms, ok: ${result.ok}, code: ${result.code}`);
if (result.stderr) console.log("stderr:", result.stderr.slice(0, 500));
await page.close();
