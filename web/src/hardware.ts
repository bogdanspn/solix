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

export interface PanelSetup {
  panelsPerInput: number;
  panelW: number;
  bifacial: boolean;
}

export interface PanelConfiguration extends PanelSetup {
  enabled: boolean;
  individual?: boolean;
  inputs?: PanelSetup[];
}

function isPanelSetup(value: unknown, minimum: number): value is PanelSetup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const setup = value as PanelSetup;
  return typeof setup.bifacial === "boolean"
    && Number.isInteger(setup.panelsPerInput) && setup.panelsPerInput >= minimum && setup.panelsPerInput <= 3
    && Number.isFinite(setup.panelW) && setup.panelW >= 1 && setup.panelW <= 500;
}

export function panelSetups(configuration: PanelConfiguration, count: number): PanelSetup[] {
  return Array.from({ length: count }, (_, index) => configuration.individual
    ? configuration.inputs![index]!
    : { panelsPerInput: configuration.panelsPerInput, panelW: configuration.panelW, bifacial: configuration.bifacial });
}

export function isPanelConfiguration(value: unknown): value is PanelConfiguration {
  if (typeof value !== "object" || value === null) return false;
  const config = value as PanelConfiguration;
  return typeof config.enabled === "boolean" && isPanelSetup(config, 1)
    && (config.individual === undefined || typeof config.individual === "boolean")
    && (config.inputs === undefined ? !config.individual : Array.isArray(config.inputs)
      && config.inputs.length === 4 && Array.from(config.inputs).every((setup) => isPanelSetup(setup, 0)));
}