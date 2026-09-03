import type { DataType, RegisterDef } from "./registers.ts";

/**
 * Decode a value out of a block of 16-bit registers.
 *
 * @param words  The raw register words for the whole block.
 * @param offset Index of this value's first word within `words`.
 */
export function decodeValue(
  words: readonly number[],
  offset: number,
  def: Pick<RegisterDef, "type" | "count" | "gain">,
): number | string | null {
  const slice = words.slice(offset, offset + def.count);
  if (slice.length < def.count || slice.some((w) => w === undefined)) return null;

  if (def.type === "STRING") return decodeString(slice);

  const raw = decodeNumber(slice, def.type);
  if (raw === null) return null;
  return def.gain && def.gain !== 1 ? raw / def.gain : raw;
}

function decodeNumber(words: number[], type: DataType): number | null {
  const hi = words[0];
  if (hi === undefined) return null;

  switch (type) {
    case "UINT16":
      return hi & 0xffff;
    case "INT16":
      return (hi & 0x8000) !== 0 ? (hi & 0xffff) - 0x10000 : hi & 0xffff;
    case "UINT32":
    case "INT32": {
      const lo = words[1];
      if (lo === undefined) return null;
      // Big-endian word order: high register first. This is what Anker's own
      // integration assumes, and the probe verifies it against known-sane
      // values before we trust any of it.
      const u = ((hi & 0xffff) * 0x10000 + (lo & 0xffff)) >>> 0;
      return type === "INT32" && u > 0x7fffffff ? u - 0x100000000 : u;
    }
    default:
      return null;
  }
}

/** Anker packs two ASCII chars per register, high byte first, NUL-padded. */
function decodeString(words: number[]): string {
  const bytes: number[] = [];
  for (const w of words) {
    bytes.push((w >> 8) & 0xff, w & 0xff);
  }
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.slice(0, end))
    .toString("ascii")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
}

/** Encode a numeric value for writing. Only single-register writes are exposed. */
export function encodeUint16(value: number): number {
  return Math.round(value) & 0xffff;
}
