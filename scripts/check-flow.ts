import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://localhost:8787/", { waitUntil: "networkidle" });
  await page.waitForSelector(".flow-wrap svg", { timeout: 20000 });
  await page.waitForTimeout(1500);

  const live = await page.evaluate(async () => {
    const r = await fetch("/api/live");
    const d = await r.json();
    return { batteryW: d.batteryW, gridW: d.gridW, pvW: d.pvW, homeW: d.homeW, status: d.batteryStatus };
  });
  console.log("live:", JSON.stringify(live));

  const paths = await page.evaluate(() => {
    const out: Array<Record<string, string>> = [];
    document.querySelectorAll<SVGPathElement>(".flow-wrap svg path").forEach((p) => {
      const cs = getComputedStyle(p);
      if (cs.animationName === "none") return;
      out.push({
        d: p.getAttribute("d") ?? "",
        stroke: p.getAttribute("stroke") ?? "",
        direction: cs.animationDirection,
        duration: cs.animationDuration,
      });
    });
    return out;
  });

  for (const p of paths) {
    // Work out which way the dashes actually travel on screen.
    const m = /M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+)/.exec(p.d ?? "");
    let travel = "?";
    if (m) {
      const [, x1, y1, x2, y2] = m.map(Number) as [number, number, number, number, number];
      const dy = (y2 ?? 0) - (y1 ?? 0);
      const dx = (x2 ?? 0) - (x1 ?? 0);
      const fwd = Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? "down" : "up") : dx > 0 ? "right" : "left";
      const rev = { down: "up", up: "down", right: "left", left: "right" }[fwd] ?? "?";
      travel = p.direction === "reverse" ? rev : fwd;
    }
    console.log(
      "  %s  dir=%s  dashes travel %s",
      (p.stroke ?? "").padEnd(20),
      (p.direction ?? "").padEnd(8),
      travel,
    );
  }
  await browser.close();
}
main();
