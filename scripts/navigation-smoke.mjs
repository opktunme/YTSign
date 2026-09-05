import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const run = resolve(root, "work", `navigation-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
await mkdir(run, { recursive: true });
const context = await chromium.launchPersistentContext(resolve(run, "profile"), {
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: [`--disable-extensions-except=${resolve(root, "dist")}`, `--load-extension=${resolve(root, "dist")}`,
    "--disable-sync", "--no-first-run"],
});
const report = { ok: false, checks: {}, errors: [] };
try {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(String(error)));
  // A controlled YouTube-origin document isolates SPA routing from ads and
  // network playback. Real YouTube playback is covered by extension-smoke.
  await page.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html",
    body: '<!doctype html><html><body><main>Navigation fixture</main></body></html>' }));
  await page.goto("https://www.youtube.com/");
  await page.waitForTimeout(1500);
  if (await page.locator("#youtube-sign-live-root").count()) throw new Error("Overlay appeared on homepage");
  report.checks.homepageInactive = true;
  const navigate = async (path) => {
    await page.evaluate((path) => {
      document.documentElement.dataset.sameDocument = "navigation-fixture";
      history.pushState({}, "", path);
      document.dispatchEvent(new Event("yt-navigate-finish"));
    }, path);
  };
  await navigate("/watch?v=fixture-one");
  const overlay = page.locator("#youtube-sign-live-root");
  await overlay.waitFor({ state: "visible", timeout: 10000 });
  report.checks.homeToWatchWithoutRefresh = true;
  await navigate("/results?search_query=fixture");
  await overlay.waitFor({ state: "hidden" });
  report.checks.hiddenOnSearch = true;
  await navigate("/watch?v=fixture-two");
  await overlay.waitFor({ state: "visible" });
  if (await overlay.count() !== 1) throw new Error("Duplicate overlays after SPA navigation");
  if (await page.locator("html").getAttribute("data-same-document") !== "navigation-fixture")
    throw new Error("Test document unexpectedly reloaded");
  report.checks.watchReentrySingleOverlay = true;
  report.ok = report.errors.length === 0;
} catch (error) { report.error = String(error?.stack || error); }
finally {
  await context.close();
  await writeFile(resolve(run, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ run, ...report }));
if (!report.ok) process.exitCode = 1;
