/** Read-only: what the mode-related registers actually hold right now. */
import ModbusRTU from "modbus-serial";
import { config } from "../server/config.ts";

const WATCH: Array<[number, string]> = [
  [10064, "operating_mode (10064)"],
  [32774, "ems_mode_mask (32774)"],
  [0x8007, "parallel_capability (0x8007)"],
  [10040, "unknown 10040"],
  [10041, "unknown 10041"],
  [10230, "unknown 10230"],
  [60003, "backup_soc_enable (60003)"],
];

async function main() {
  const c = new ModbusRTU();
  await c.connectTCP(config.host, { port: config.port });
  c.setID(config.unitId);
  c.setTimeout(2500);
  for (const [addr, label] of WATCH) {
    try {
      const v = ((await c.readHoldingRegisters(addr, 1)).data as number[])[0] ?? 0;
      console.log(
        label.padEnd(30) + " = " + String(v).padEnd(7) +
        " bin " + v.toString(2).padStart(16, "0"),
      );
    } catch {
      console.log(label.padEnd(30) + " = <unsupported>");
    }
  }
  c.close(() => {});
}
main();
