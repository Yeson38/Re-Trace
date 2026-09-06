import puppeteer from "puppeteer-core";

const version = await fetch("http://127.0.0.1:9222/json/version").then(r => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl, protocolTimeout: 0 });
const page = await browser.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 30000 });

// Test with RtBuf only (no template containers)
const header = `
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <new>

namespace retrace {
struct RtBuf {
  char* data;
  size_t len;
  size_t cap;
  RtBuf() : data(nullptr), len(0), cap(0) {}
  ~RtBuf() { std::free(data); }
  void reserve(size_t n) {
    if (n <= cap) return;
    cap = n + 16;
    data = (char*)std::realloc(data, cap);
  }
  void append(const char* s) {
    size_t n = std::strlen(s);
    reserve(len + n + 1);
    std::memcpy(data + len, s, n);
    len += n;
    data[len] = 0;
  }
};
}
`;
const src = header + `\nint main() { retrace::RtBuf b; b.append("hi"); return 0; }\n`;

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
  return { ok: out.ok, code: out.code, compileMs: Date.now() - t1, stderr: out.stderr };
}, src);
console.log(`RtBuf only: compile=${result.compileMs}ms ok=${result.ok}`);
if (result.stderr) console.log(result.stderr.slice(0, 300));
await page.close();
