import puppeteer from "puppeteer-core";

const version = await fetch("http://127.0.0.1:9222/json/version").then(r => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl, protocolTimeout: 0 });
const pages = await browser.pages();
const page = pages[0] || (await browser.newPage());

const log = [];
page.on("console", (m) => {
  const line = `[${m.type()}] ${m.text()}`;
  log.push(line);
  // Print retrace/cpp logs in real-time for debugging
  if (line.includes("retrace/cpp") || line.includes("retrace") || m.type() === "error") {
    console.log("  BROWSER:", line.substring(0, 300));
  }
});
page.on("pageerror", (e) => {
  log.push(`[pageerror] ${e.message}`);
  console.log("  BROWSER [pageerror]:", e.message?.substring(0, 300));
});

await page.goto("http://localhost:5173/", { waitUntil: "networkidle2", timeout: 90000 });

await page.waitForFunction(
  () => window.__retrace && window.__retrace.recorder,
  { timeout: 30000 }
);
console.log("Recorder ready.");

const cppSource = `#include <cstdio>

void bubble_sort(int arr[], int n) {
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n - i - 1; j++) {
            if (arr[j] > arr[j + 1]) {
                int t = arr[j];
                arr[j] = arr[j + 1];
                arr[j + 1] = t;
            }
        }
    }
}

int main() {
    int data[] = {5, 2, 8, 1, 4};
    int n = 5;
    bubble_sort(data, n);
    for (int i = 0; i < n; i++) printf("%d ", data[i]);
    printf("\\n");
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
