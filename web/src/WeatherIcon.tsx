import type { JSX } from "react";
import {
  IconDrizzle,
  IconFog,
  IconMoonClear,
  IconOvercast,
  IconPartlyDay,
  IconPartlyNight,
  IconRain,
  IconSnow,
  IconSun,
  IconThunder,
} from "./Icons.tsx";

/**
 * WMO weather code to icon and wording.
 *
 * The code comes from the forecast rather than being inferred from cloud
 * cover, because 90% cloud can be dry overcast or a downpour and only the code
 * separates them. Day and night differ for the clear and partly-cloudy cases,
 * where a sun at midnight would be plainly wrong.
 */
export function weatherLook(code: number, isDay: boolean): {
  Icon: (p: { size?: number }) => JSX.Element;
  label: string;
  tone: string;
} {
  if (code === 0) {
    return isDay
      ? { Icon: IconSun, label: "Clear", tone: "var(--solar)" }
      : { Icon: IconMoonClear, label: "Clear", tone: "var(--text-secondary)" };
  }
  if (code === 1) {
    return isDay
      ? { Icon: IconSun, label: "Mainly clear", tone: "var(--solar)" }
      : { Icon: IconMoonClear, label: "Mainly clear", tone: "var(--text-secondary)" };
  }
  if (code === 2) {
    return isDay
      ? { Icon: IconPartlyDay, label: "Partly cloudy", tone: "var(--solar)" }
      : { Icon: IconPartlyNight, label: "Partly cloudy", tone: "var(--text-secondary)" };
  }
  if (code === 3) return { Icon: IconOvercast, label: "Overcast", tone: "var(--text-muted)" };
  if (code === 45 || code === 48) return { Icon: IconFog, label: "Fog", tone: "var(--text-muted)" };
  if (code >= 51 && code <= 57) return { Icon: IconDrizzle, label: "Drizzle", tone: "var(--home)" };
  if (code >= 61 && code <= 67) return { Icon: IconRain, label: "Rain", tone: "var(--home)" };
  if (code >= 71 && code <= 77) return { Icon: IconSnow, label: "Snow", tone: "var(--home)" };
  if (code >= 80 && code <= 82) return { Icon: IconRain, label: "Showers", tone: "var(--home)" };
  if (code === 85 || code === 86) return { Icon: IconSnow, label: "Snow showers", tone: "var(--home)" };
  if (code >= 95) return { Icon: IconThunder, label: "Thunderstorm", tone: "var(--warning)" };
  // Unrecognised codes get a neutral cloud rather than a wrong sun.
  return { Icon: IconOvercast, label: `Code ${code}`, tone: "var(--text-muted)" };
}
