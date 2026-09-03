/** Exercise the charge/discharge estimate against known inputs. */
import { estimateEta, resetRateHistory } from "../server/poll.ts";
import type { Snapshot } from "../server/types.ts";

const RATED = 15.1;

function snap(soc: number, batteryW: number, chargeLimit: number, dischargeLimit: number): Snapshot {
  return {
    ts: Date.now(),
    soc,
    batteryW,
    settings: { chargingLimitSoc: chargeLimit, dischargeLimitSoc: dischargeLimit },
  } as unknown as Snapshot;
}

const cases: Array<[string, Snapshot, string]> = [
  ["charging 36% -> 100% at 720 W", snap(36, 720, 100, 10), "(100-36)% of 15.1 kWh / 0.72 kW"],
  ["discharging 80% -> 10% at 900 W", snap(80, -900, 100, 10), "(80-10)% of 15.1 kWh / 0.90 kW"],
  ["discharging 15% -> 10% at 400 W", snap(15, -400, 100, 10), "nearly at the floor"],
  ["already at the floor", snap(10, -400, 100, 10), "no headroom left"],
  ["standby", snap(50, 0, 100, 10), "below the 60 W threshold"],
];

for (const [label, s, note] of cases) {
  resetRateHistory();
  const e = estimateEta(s, RATED);
  const mins = e.minutes === null ? "-" : `${Math.floor(e.minutes / 60)}h ${e.minutes % 60}m`;
  console.log(
    label.padEnd(34) + " dir=" + e.direction.padEnd(10) +
    " to " + String(e.targetSoc).padStart(3) + "%" +
    "  eta " + mins.padStart(9) + "   " + note,
  );
}

// Independent check of the arithmetic.
const expect = ((80 - 10) / 100) * RATED / 0.9 * 60;
console.log("\nhand-computed discharge case: " + expect.toFixed(0) + " minutes");
