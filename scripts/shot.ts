/**
 * Screenshot the running dashboard.
 *
 *   npm run shot              both themes, full page
 *   npm run shot -- light     one theme
 *
 * Uses Playwright's own bundled Chromium rather than the system Edge/Chrome,
 * which refuses to run headless under this machine's policy.
 */
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(import.meta.dirname, "..");
const URL = process.env.SHOT_URL ?? `http://localhost:${process.env.HTTP_PORT ?? 8787}/`;

async function main() {
  const arg = process.argv[2];
  const openSettings = process.argv.includes("--settings");
  const themes = arg === "light" || arg === "dark" ? [arg] : ["dark", "light"];

  const browser = await chromium.launch();
  try {
    for (const theme of themes) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

      // Set the stored preference before any script runs, so the app boots
      // straight into the theme instead of flashing the other one.
      await page.addInitScript((t) => {
        try {
          localStorage.setItem("solix-theme", t);
        } catch {
          /* ignore */
        }
      }, theme);

      await page.goto(URL, { waitUntil: "networkidle" });
      // Wait for real data rather than the connecting placeholder.
      await page.waitForSelector(".tiles", { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(1500);

      if (openSettings) {
        await page.click('button[title="Settings"]');
        await page.waitForTimeout(600);
      }

      const out = path.join(ROOT, `shot-${theme}${openSettings ? "-settings" : ""}.png`);
      await page.screenshot({ path: out, fullPage: !openSettings });
      console.log("wrote %s", out);

      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      if (errors.length) console.warn("page errors: %s", errors.join(" · "));

      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
