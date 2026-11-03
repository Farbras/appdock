import fs from "node:fs";
import { chromium } from "playwright";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const samples = [];
try {
  for (let i = 0; i < 10; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const start = performance.now();
    await page.goto("http://127.0.0.1:4173/");
    await page.getByRole("textbox", { name: "Поиск программ" }).waitFor();
    await page.locator(".product-card").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    samples.push(performance.now() - start);
    await context.close();
  }
} finally {
  await browser.close();
}
const sorted = [...samples].sort((a, b) => a - b);
const result = {
  environment:
    "Production Vite preview, fresh Edge browser contexts; excludes native WebView2 initialization and real discovery",
  samples,
  medianMs: sorted[5],
  maxMs: sorted.at(-1),
};
fs.writeFileSync(
  "artifacts/fix-2026-11-02/startup-production.json",
  JSON.stringify(result, null, 2),
);
console.log(result);
