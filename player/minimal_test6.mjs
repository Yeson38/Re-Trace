import puppeteer from "puppeteer-core";

const version = await fetch("http://127.0.0.1:9222/json/version").then(r => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl, protocolTimeout: 0 });
const page = await browser.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 30000 });

// Test with to_json overloads (many inline functions)
const header = `
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <new>

namespace retrace {
struct RtBuf {
  char* data = nullptr; size_t len = 0; size_t cap = 0;
  ~RtBuf() { std::free(data); }
  void reserve(size_t n) { if (n <= cap) return; cap = n + 16; data = (char*)std::realloc(data, cap); }
  void append(const char* s) { size_t n = std::strlen(s); reserve(len + n + 1); std::memcpy(data + len, s, n); len += n; data[len] = 0; }
  void append(char c) { reserve(len + 2); data[len++] = c; data[len] = 0; }
};

inline void rt_json_escape(RtBuf& out, const char* s) {
  out.append('"');
  for (; *s; s++) { if (*s == '"') out.append("\\\""); else out.append(*s); }
  out.append('"');
}

inline void to_json(RtBuf& out, const char* v) { rt_json_escape(out, v ? v : ""); }
inline void to_json(RtBuf& out, char* v) { rt_json_escape(out, v ? v : ""); }
inline void to_json(RtBuf& out, bool v) { out.append(v ? "true" : "false"); }
inline void to_json(RtBuf& out, char v) { char b[16]; std::snprintf(b, sizeof(b), "%d", (int)v); out.append(b); }
inline void to_json(RtBuf& out, int v) { char b[32]; std::snprintf(b, sizeof(b), "%d", v); out.append(b); }
inline void to_json(RtBuf& out, unsigned v) { char b[32]; std::snprintf(b, sizeof(b), "%u", v); out.append(b); }
inline void to_json(RtBuf& out, long v) { char b[32]; std::snprintf(b, sizeof(b), "%ld", v); out.append(b); }
inline void to_json(RtBuf& out, unsigned long v) { char b[32]; std::snprintf(b, sizeof(b), "%lu", v); out.append(b); }
inline void to_json(RtBuf& out, long long v) { char b[32]; std::snprintf(b, sizeof(b), "%lld", v); out.append(b); }
inline void to_json(RtBuf& out, float v) { char b[64]; std::snprintf(b, sizeof(b), "%.9g", (double)v); out.append(b); }
inline void to_json(RtBuf& out, double v) { char b[64]; std::snprintf(b, sizeof(b), "%.9g", v); out.append(b); }
template <typename T, size_t N> void to_json(RtBuf& out, const T (&v)[N]) { out.append('['); for (size_t i=0;i<N;i++) { if(i) out.append(", "); to_json(out, v[i]); } out.append(']'); }
template <size_t N> void to_json(RtBuf& out, const char (&v)[N]) { rt_json_escape(out, v); }
template <typename T> void to_json(RtBuf& out, const T&) { out.append("\\\"<object>\\\""); }
}
`;
const src = header + `\nint main() { retrace::RtBuf b; retrace::to_json(b, 42); return 0; }\n`;

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
console.log(`to_json overloads: compile=${result.compileMs}ms ok=${result.ok}`);
if (result.stderr) console.log(result.stderr.slice(0, 500));
await page.close();
