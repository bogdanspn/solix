import { client, getLatest } from "./poll.ts";
import { REGISTERS, WRITABLE_KEYS, type WritableKey } from "./registers.ts";

export interface WriteResult {
  ok: boolean;
  key: WritableKey;
  requested: number;
  /** What the device reports after the write. */
  readBack: number | null;
  message?: string;
}

export function isWritableKey(key: string): key is WritableKey {
  return (WRITABLE_KEYS as readonly string[]).includes(key);
}

/**
 * Translate an API value into the raw register value, rejecting anything out
 * of range. These writes change how the battery actually behaves, so a bad
 * value is refused here rather than passed to the device.
 */
function toRaw(key: WritableKey, value: unknown): { raw: number } | { error: string } {
  const def = REGISTERS[key];

  if (key === "backup_soc_enable") {
    if (typeof value === "boolean") return { raw: value ? 1 : 0 };
    if (value === 0 || value === 1) return { raw: value };
    return { error: "backup_soc_enable expects a boolean" };
  }

  const n = Number(value);
  if (!Number.isFinite(n)) return { error: `${key} expects a number` };

  const min = (def as { min?: number }).min ?? 0;
  const max = (def as { max?: number }).max ?? 100;
  if (n < min || n > max) return { error: `${key} must be between ${min} and ${max}` };

  return { raw: Math.round(n) };
}

export async function writeSetting(key: WritableKey, value: unknown): Promise<WriteResult> {
  const converted = toRaw(key, value);
  if ("error" in converted) {
    return { ok: false, key, requested: NaN, readBack: null, message: converted.error };
  }

  // Charge and discharge limits must not cross, or the device is left with an
  // impossible window.
  const current = getLatest();
  if (current) {
    const { chargingLimitSoc, dischargeLimitSoc } = current.settings;
    if (key === "charging_limit_soc" && converted.raw <= dischargeLimitSoc) {
      return {
        ok: false, key, requested: converted.raw, readBack: null,
        message: `Charge limit must stay above the discharge limit (${dischargeLimitSoc}%)`,
      };
    }
    if (key === "discharge_limit_soc" && converted.raw >= chargingLimitSoc) {
      return {
        ok: false, key, requested: converted.raw, readBack: null,
        message: `Discharge limit must stay below the charge limit (${chargingLimitSoc}%)`,
      };
    }
  }

  const def = REGISTERS[key];
  try {
    const readBack = await client.writeRegister(def.address, converted.raw);
    const ok = readBack === converted.raw;
    return {
      ok,
      key,
      requested: converted.raw,
      readBack,
      // A silently-ignored write is the failure mode worth naming: several
      // Solarbank controls only take effect in third-party control mode.
      message: ok
        ? undefined
        : "The device did not accept this value. Some controls only apply in " +
          "third-party control mode; check the operating mode.",
    };
  } catch (err) {
    return {
      ok: false,
      key,
      requested: converted.raw,
      readBack: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
