/** How long a full poll cycle actually takes against the real hardware. */
import ModbusRTU from "modbus-serial";
import { config } from "../server/config.ts";
import { BLOCKS } from "../server/registers.ts";

async function main() {
  const c = new ModbusRTU();
  await c.connectTCP(config.host, { port: config.port });
  c.setID(config.unitId);
  c.setTimeout(4000);

  const times: number[] = [];
  for (let round = 0; round < 5; round++) {
    const t0 = performance.now();
    for (const b of BLOCKS) await c.readHoldingRegisters(b.start, b.count);
    times.push(performance.now() - t0);
  }
  c.close(() => {});
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log("Solarbank: %d blocks/poll, %s ms", BLOCKS.length, times.map((t) => t.toFixed(0)).join(", "));
  console.log("  average %s ms per full cycle", avg.toFixed(0));

  // One plug, for comparison.
  const hosts = config.plugHosts;
  if (hosts[0]) {
    const pc = new ModbusRTU();
    await pc.connectTCP(hosts[0], { port: config.port });
    pc.setID(config.unitId);
    pc.setTimeout(3000);
    const pt: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await pc.readHoldingRegisters(30029, 9);
      pt.push(performance.now() - t0);
    }
    pc.close(() => {});
    console.log(
      "Plug %s: %s ms (avg %s)",
      hosts[0],
      pt.map((t) => t.toFixed(0)).join(", "),
      (pt.reduce((a, b) => a + b, 0) / pt.length).toFixed(0),
    );
  }
  console.log("\nConfigured poll interval: %d ms", config.pollIntervalMs);
}
main();
