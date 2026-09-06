import type { PvString } from "../../server/types.ts";

export const SOLARBANK_4 = {
  model: "AE103",
  name: "Solarbank 4 E5000 Pro",
  mppts: 4,
  solarW: 5000,
  advertisedPanels: 12,
  baseKwh: 5.024,
  gridOutputW: 2500,
  acChargeW: 2500,
  bypassW: 3600,
  mpptMinV: 16,
  mpptMaxV: 50,
  maxPvV: 60,
  maxMpptA: 36,
  protection: "IP66",
  chemistry: "LiFePO4",
  source: "https://www.anker.com/de/products/ae103",
};

export function hardwareFor(model?: string) {
  return model?.trim().toUpperCase() === SOLARBANK_4.model ? SOLARBANK_4 : null;
}

export function seriesPanelEstimate(reading: PvString, panelVmp: number, fresh: boolean): number | null {
  if (!fresh || reading.derived || !Number.isFinite(panelVmp) || panelVmp <= 0
    || !Number.isFinite(reading.volts) || !Number.isFinite(reading.amps) || !Number.isFinite(reading.watts)
    || reading.volts <= 0 || reading.amps < 0.5 || reading.watts < 20) return null;
  const ratio = reading.volts / panelVmp;
  const candidates = Array.from({ length: 12 }, (_, index) => index + 1)
    .filter((count) => Math.abs(ratio - count) <= count * 0.15);
  return candidates.length === 1 ? candidates[0]! : null;
}

export function pvInputStatus(reading: PvString, model: string | undefined, fresh: boolean) {
  const hardware = hardwareFor(model);
  if (!fresh) return "Last reading";
  if (reading.derived) return "Power inferred; voltage/current unavailable";
  if (![reading.volts, reading.amps, reading.watts].every(Number.isFinite)) return "Reading unavailable";
  if (!hardware) return "Limits not verified for this model";
  if (reading.volts >= hardware.maxPvV) return "At or above maximum PV voltage";
  if (reading.amps > hardware.maxMpptA) return "Above MPPT current rating";
  if (reading.watts < 20 || reading.amps < 0.5) return "Low light / idle";
  if (reading.volts < hardware.mpptMinV || reading.volts > hardware.mpptMaxV) return "Outside MPPT operating range";
  return "Within operating range";
}

export function isPanelVoltages(value: unknown): value is Record<string, number> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([key, volts]) => /^[1-4]$/.test(key) && typeof volts === "number" && Number.isFinite(volts) && volts > 0 && volts <= 60);
}

export interface PanelConfiguration {
  enabled: boolean;
  panelsPerInput: number;
  panelW: number;
  bifacial: boolean;
}

export function isPanelConfiguration(value: unknown): value is PanelConfiguration {
  if (typeof value !== "object" || value === null) return false;
  const config = value as PanelConfiguration;
  return typeof config.enabled === "boolean" && typeof config.bifacial === "boolean"
    && Number.isInteger(config.panelsPerInput) && config.panelsPerInput >= 1 && config.panelsPerInput <= 12
    && Number.isFinite(config.panelW) && config.panelW >= 1 && config.panelW <= 2000;
}