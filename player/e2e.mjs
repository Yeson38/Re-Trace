import puppeteer from "puppeteer-core";

const version = await fetch("http://127.0.0.1:9222/json/version").then(r => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl });
const pages = await browser.pages();
const page = pages[0] || (await browser.newPage());

const log = [];
page.on("console", (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));

await page.goto("http://localhost:5173/", { waitUntil: "networkidle0", timeout: 90000 });

let ready = false;
for (let i = 0; i < 90; i++) {
  const r = await page.evaluate(() => {
    const w = window.__retrace;
    return { hasHook: !!w, recorder: !!w?.recorder, monaco: !!w?.monaco };
  });
  if (i % 10 === 0) console.log(`  t=${i}s`, JSON.stringify(r));
  if (r.hasHook && r.recorder) { ready = true; break; }
  await new Promise((res) => setTimeout(res, 1000));
}
if (!ready) {
  console.log("Recorder NOT ready after 60s. Dumping console:");
  log.slice(-40).forEach((l) => console.log("  " + l));
  await browser.disconnect();
  process.exit(2);
}
console.log("Recorder ready.");

const pySource = `def bubble(a):
    n = len(a)
    for i in range(n):
        for j in range(0, n - i - 1):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]
    return a

bubble([5, 2, 9, 1])
`;

console.log("Starting Python record...");
const pyResult = await page.evaluate(async (src) => {
  const r = await window.__retrace.recorder.recordPython(src, { tempFileName: "bubble.py" });
  return {
    ok: r.ok,
    steps: r.ok ? r.traceFile.steps.length : null,
    summary: r.summary,
    language: r.ok ? r.traceFile.source.language : null,
  };
}, pySource);

console.log("Python result:", JSON.stringify(pyResult, null, 2));

if (pyResult.ok) {
  console.log(`\n[PASS] Python recording: ${pyResult.steps} steps (lang=${pyResult.language})`);
} else {
  console.log(`\n[FAIL] Python recording: ${pyResult.summary}`);
  log.slice(-20).forEach((l) => console.log("  " + l));
}

await browser.disconnect();
process.exit(pyResult.ok ? 0 : 1);
