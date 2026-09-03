/**
 * Read-only sweep of the Solarbank's register space, to find what the device
 * exposes beyond the documented map.
 *
 * Strictly reads. Nothing here writes, so it cannot change device behaviour.
 * Unsupported addresses raise a Modbus exception, which is how we tell a real
 * register from a gap.
 *
 *   npm run explore                 # the Solarbank
 *   npm run explore -- 192.168.1.51 # a socket
 */
import ModbusRTU from "modbus-serial";
import { config } from "../server/config.ts";
import { REGISTERS } from "../server/registers.ts";

const HOST = process.argv[2] ?? config.host;

/** Ranges worth sweeping, chosen around the blocks we already know. */
const RANGES: Array<[number, number]> = [
  [10000, 10400],
  [10600, 10720],
  [20000, 20060],
  [30000, 30100],
  [32760, 32800],
  [40000, 40060],
  [50000, 50120],
  [60000, 60080],
];

const KNOWN = new Map<number, string>();
for (const [name, def] of Object.entries(REGISTERS)) {
  for (let i = 0; i < def.count; i++) KNOWN.set(def.address + i, name);
}

const client = new ModbusRTU();

async function readChunk(start: number, count: number): Promise<number[] | null> {
  try {
    const res = await client.readHoldingRegisters(start, count);
    return res.data as number[];
  } catch {
    return null;
  }
}

function ascii(words: number[]): string {
  const bytes: number[] = [];
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
  const end = bytes.indexOf(0);
  const s = Buffer.from(end === -1 ? bytes : bytes.slice(0, end)).toString("ascii");
  return /^[\x20-\x7e]{2,}$/.test(s) ? s : "";
}

async function main() {
  await client.connectTCP(HOST, { port: config.port });
  client.setID(config.unitId);
  client.setTimeout(2500);

  console.log("Sweeping %s:%d unit %d (read-only)\n", HOST, config.port, config.unitId);

  const live = new Map<number, number>();

  for (const [from, to] of RANGES) {
    let found = 0;
    for (let addr = from; addr < to; addr += 8) {
      const words = await readChunk(addr, 8);
      if (!words) continue;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w === undefined) continue;
        live.set(addr + i, w);
        found++;
      }
    }
    if (found) console.log("  %d-%d: %d readable registers", from, to, found);
  }

  console.log("\n=== Undocumented registers with a non-zero value ===");
  console.log("(addr, raw u16, as int16, and the u32 formed with the next word)\n");

  const addrs = [...live.keys()].sort((a, b) => a - b);
  let shown = 0;
  for (const addr of addrs) {
    if (KNOWN.has(addr)) continue;
    const w = live.get(addr) ?? 0;
    if (w === 0) continue;

    const i16 = w > 0x7fff ? w - 0x10000 : w;
    const next = live.get(addr + 1);
    const u32 = next === undefined ? null : (w * 0x10000 + next) >>> 0;
    const i32 = u32 === null ? null : u32 > 0x7fffffff ? u32 - 0x100000000 : u32;

    // A run of printable words is probably a string field.
    const str = ascii([w, next ?? 0, live.get(addr + 2) ?? 0, live.get(addr + 3) ?? 0]);

    console.log(
      "  %s  u16=%s  i16=%s  u32=%s  i32=%s%s",
      String(addr).padEnd(6),
      String(w).padEnd(7),
      String(i16).padEnd(8),
      String(u32 ?? "-").padEnd(11),
      String(i32 ?? "-").padEnd(11),
      str ? `  ascii=${JSON.stringify(str)}` : "",
    );
    shown++;
  }

  console.log("\n%d readable registers total, %d undocumented and non-zero.", live.size, shown);
  client.close(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
