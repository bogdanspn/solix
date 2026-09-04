import type { Snapshot } from "../../server/types.ts";

/**
 * What the house is drawing that the Solarbank is not supplying.
 *
 * The exact complement of the server's unmeteredW, which is the output the
 * sockets do not account for. Once the battery is at its discharge floor the
 * Solarbank puts out nothing and this is the whole of the house load.
 *
 * Null when it cannot be derived: with a Smart Meter paired, gridW is a real
 * grid measurement that already carries the import, and without sockets there
 * is no house figure to subtract from. Null means leave the readout out
 * rather than print a zero that cannot be stood behind.
 */
export function mainsInputW(s: Snapshot): number | null {
  if (s.gridMeasured || s.homeSource !== "sockets") return null;
  return Math.max(0, Math.round(s.homeW - Math.abs(s.acOutW)));
}
