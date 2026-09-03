/**
 * Watch the operating-mode register while you switch modes in the Anker app.
 *
 * Read-only. Change the mode in the app; each new value is printed with a
 * timestamp so the register/mode mapping can be recorded as fact rather than
 * guessed from another model's documentation.
 */
import ModbusRTU from "modbus-serial";
import { config } from "../server/config.ts";

async function main() {
  const c = new ModbusRTU();
  await c.connectTCP(config.host, { port: config.port });
  c.setID(config.unitId);
  c.setTimeout(2500);

  console.log("Watching operating_mode (10064) and ems_mode_mask (32774).");
  console.log("Switch modes in the Anker app; each change is logged. Ctrl+C to stop.\n");

  let lastMode: number | null = null;
  let lastMask: number | null = null;
  const seen = new Map<number, string>();

  for (;;) {
    try {
      const mode = ((await c.readHoldingRegisters(10064, 1)).data as number[])[0] ?? -1;
      const mask = ((await c.readHoldingRegisters(32774, 1)).data as number[])[0] ?? -1;

      if (mode !== lastMode || mask !== lastMask) {
        const when = new Date().toLocaleTimeString();
        console.log(
          when + "   operating_mode = " + String(mode).padEnd(4) +
          "   ems_mode_mask = " + String(mask).padEnd(6) +
          " (bin " + mask.toString(2).padStart(8, "0") + ")",
        );
        if (mode !== lastMode && lastMode !== null) {
          console.log("            ^ mode changed - note which mode you just selected");
        }
        seen.set(mode, when);
        lastMode = mode;
        lastMask = mask;
      }
    } catch (e) {
      console.warn("read failed:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
main();
