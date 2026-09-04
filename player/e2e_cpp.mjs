import puppeteer from "puppeteer-core";

const version = await fetch("http://127.0.0.1:9222/json/version").then(r => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl, protocolTimeout: 0 });
const pages = await browser.pages();
const page = pages[0] || (await browser.newPage());

const log = [];
page.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 90000 });

await page.waitForFunction(
  () => window.__retrace && window.__retrace.recorder,
  { timeout: 30000 }
);
console.log("Recorder ready.");

const cppSource = `#include <iostream>
#include <vector>
using namespace std;

int main() {
    vector<int> a = {5, 2, 9, 1};
    int n = a.size();
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n - i - 1; j++) {
            if (a[j] > a[j+1]) {
                int t = a[j];
                a[j] = a[j+1];
                a[j+1] = t;
            }
        }
    }
    for (int x : a) cout << x << " ";
    cout << endl;
    return 0;
}
`;

console.log("Starting C++ record (clang download may take a while)...");
const t0 = Date.now();
const cppResult = await page.evaluate(async (src) => {
  let r;
  try {
    r = await window.__retrace.recorder.recordCpp(src, { tempFileName: "bubble.cpp" });
  } catch (e) {
    return { ok: false, summary: "THROWN: " + (e?.message ?? String(e)), stack: e?.stack };
  }
  return {
    ok: r.ok,
    steps: r.ok ? r.traceFile.steps.length : null,
    summary: typeof r.summary === "string" ? r.summary : JSON.stringify(r.summary),
    language: r.ok ? r.traceFile.source.language : null,
    diagnostics: r.ok ? null : (r.diagnostics ? r.diagnostics.length : 0),
  };
}, cppSource);
const dt = Date.now() - t0;

console.log(`C++ result (${(dt/1000).toFixed(1)}s):`, JSON.stringify(cppResult, null, 2));

if (cppResult.ok) {
  console.log(`\n[PASS] C++ recording: ${cppResult.steps} steps (lang=${cppResult.language})`);
} else {
  console.log(`\n[FAIL] C++ recording: ${cppResult.summary}`);
  console.log("--- full console log ---");
  log.forEach((l) => console.log("  " + l));
}

await browser.disconnect();
process.exit(cppResult.ok ? 0 : 1);
