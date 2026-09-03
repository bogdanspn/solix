/**
 * One icon set, drawn on a 20x20 grid at a consistent 1.5 stroke so they sit
 * together without any one looking heavier than the rest.
 */
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconSun = (p: Props) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="3.6" />
    <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4" />
  </Svg>
);

export const IconBattery = (p: Props) => (
  <Svg {...p}>
    <rect x="2" y="6.5" width="14" height="7" rx="2.2" />
    <path d="M18 9v2" />
  </Svg>
);

export const IconHome = (p: Props) => (
  <Svg {...p}>
    <path d="M3 8.6 10 3l7 5.6" />
    <path d="M4.6 10v7h10.8v-7" />
  </Svg>
);

export const IconGrid = (p: Props) => (
  <Svg {...p}>
    <path d="M10 2v3" />
    <path d="M4.6 5h10.8" />
    <path d="M5.8 5 3.6 18M14.2 5l2.2 13" />
    <path d="M5.2 9.6h9.6M4.6 13.8h10.8" />
  </Svg>
);

export const IconPlug = (p: Props) => (
  <Svg {...p}>
    <path d="M7 2.6v4M13 2.6v4" />
    <path d="M4.6 6.6h10.8v3a5.4 5.4 0 0 1-10.8 0z" />
    <path d="M10 15v2.6" />
  </Svg>
);

export const IconChart = (p: Props) => (
  <Svg {...p}>
    <path d="M2.6 14.6 7 9.4l3.4 3 4.9-6" />
    <path d="M15.4 6.4h-3.1M15.4 6.4v3" />
  </Svg>
);

export const IconSliders = (p: Props) => (
  <Svg {...p}>
    <path d="M3 6.2h5.2M11.8 6.2H17M3 13.8h2.4M9 13.8h8" />
    <circle cx="10" cy="6.2" r="1.9" />
    <circle cx="7.2" cy="13.8" r="1.9" />
  </Svg>
);

export const IconBolt = (p: Props) => (
  <Svg {...p}>
    <path d="M10.8 2 4.6 11h4l-1.4 7 6.6-9.4h-4z" />
  </Svg>
);

export const IconClock = (p: Props) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="7.6" />
    <path d="M10 5.6V10l2.8 1.8" />
  </Svg>
);

export const IconThermometer = (p: Props) => (
  <Svg {...p}>
    <path d="M12 11.4V4.6a2 2 0 1 0-4 0v6.8a3.6 3.6 0 1 0 4 0z" />
  </Svg>
);

export const IconWave = (p: Props) => (
  <Svg {...p}>
    <path d="M2.4 10c1.9-4.4 3.8-4.4 5.6 0s3.7 4.4 5.6 0 3.7-4.4 4 0" />
  </Svg>
);

export const IconHeart = (p: Props) => (
  <Svg {...p}>
    <path d="M10 16.4S3.2 12.5 3.2 7.9A3.6 3.6 0 0 1 10 6.2a3.6 3.6 0 0 1 6.8 1.7c0 4.6-6.8 8.5-6.8 8.5z" />
  </Svg>
);

export const IconRefresh = (p: Props) => (
  <Svg {...p}>
    <path d="M16.4 8.4A6.6 6.6 0 0 0 4.6 6.3" />
    <path d="M3.6 11.6a6.6 6.6 0 0 0 11.8 2.1" />
    <path d="M4.4 2.8v3.6h3.6M15.6 17.2v-3.6H12" />
  </Svg>
);

export const IconMoon = (p: Props) => (
  <Svg {...p}>
    <path d="M16.4 11.8A7 7 0 0 1 8.2 3.6a7 7 0 1 0 8.2 8.2z" />
  </Svg>
);

export const IconArrowOut = (p: Props) => (
  <Svg {...p}>
    <path d="M7.4 12.6 12.8 7.2" />
    <path d="M8.2 7.2h4.6v4.6" />
  </Svg>
);

export const IconSettings = (p: Props) => (
  <Svg {...p}>
    <path d="M3 6.4h5.4M11.6 6.4H17M3 13.6h2.4M8.6 13.6H17" />
    <circle cx="10" cy="6.4" r="2" />
    <circle cx="7" cy="13.6" r="2" />
  </Svg>
);

export const IconClose = (p: Props) => (
  <Svg {...p}>
    <path d="M5.4 5.4l9.2 9.2M14.6 5.4l-9.2 9.2" />
  </Svg>
);

export const IconCloud = (p: Props) => (
  <Svg {...p}>
    <path d="M5.8 15.4a3.4 3.4 0 0 1-.3-6.8 4.6 4.6 0 0 1 8.8-1 3.9 3.9 0 0 1 .5 7.8z" />
  </Svg>
);

export const IconDrop = (p: Props) => (
  <Svg {...p}>
    <path d="M10 2.6s5 5.4 5 8.6a5 5 0 0 1-10 0c0-3.2 5-8.6 5-8.6z" />
  </Svg>
);

export const IconPin = (p: Props) => (
  <Svg {...p}>
    <path d="M10 17.4s5.4-5 5.4-9.1a5.4 5.4 0 1 0-10.8 0c0 4.1 5.4 9.1 5.4 9.1z" />
    <circle cx="10" cy="8.2" r="2" />
  </Svg>
);

/* ---------------- weather conditions ---------------- */

export const IconMoonClear = (p: Props) => (
  <Svg {...p}>
    <path d="M16.2 12.1A6.8 6.8 0 0 1 7.9 3.8a7 7 0 1 0 8.3 8.3z" />
  </Svg>
);

export const IconPartlyDay = (p: Props) => (
  <Svg {...p}>
    <path d="M7.2 4.1V2.6M3.9 5.4 2.9 4.3M4.2 9.2H2.7M10.6 5.4l1-1.1" />
    <circle cx="7.2" cy="9.2" r="2.5" />
    <path d="M8.6 16.4a3 3 0 0 1-.3-6 4 4 0 0 1 7.7-.9 3.4 3.4 0 0 1 .4 6.9z" />
  </Svg>
);

export const IconPartlyNight = (p: Props) => (
  <Svg {...p}>
    <path d="M11.6 8.3a4.4 4.4 0 0 1-5.2-5.2 4.5 4.5 0 1 0 5.2 5.2z" />
    <path d="M8.6 16.6a3 3 0 0 1-.3-6 4 4 0 0 1 7.7-.9 3.4 3.4 0 0 1 .4 6.9z" />
  </Svg>
);

export const IconOvercast = (p: Props) => (
  <Svg {...p}>
    <path d="M6.4 8.1a3.6 3.6 0 0 1 6.9-1" />
    <path d="M5.6 15.6a3.2 3.2 0 0 1-.3-6.4 4.3 4.3 0 0 1 8.2-.9 3.6 3.6 0 0 1 .5 7.3z" />
  </Svg>
);

export const IconFog = (p: Props) => (
  <Svg {...p}>
    <path d="M5.4 11.4a3.2 3.2 0 0 1-.3-6.4 4.3 4.3 0 0 1 8.2-.9 3.6 3.6 0 0 1 .5 7.3z" />
    <path d="M3.4 14.4h13.2M5.4 17.2h9.2" />
  </Svg>
);

export const IconDrizzle = (p: Props) => (
  <Svg {...p}>
    <path d="M5.4 11.4a3.2 3.2 0 0 1-.3-6.4 4.3 4.3 0 0 1 8.2-.9 3.6 3.6 0 0 1 .5 7.3z" />
    <path d="M7 14.2v1.6M10 14.6v1.8M13 14.2v1.6" />
  </Svg>
);

export const IconRain = (p: Props) => (
  <Svg {...p}>
    <path d="M5.4 11.4a3.2 3.2 0 0 1-.3-6.4 4.3 4.3 0 0 1 8.2-.9 3.6 3.6 0 0 1 .5 7.3z" />
    <path d="M6.6 13.8 5.6 17.4M10 13.8 9 17.4M13.4 13.8l-1 3.6" />
  </Svg>
);

export const IconSnow = (p: Props) => (
  <Svg {...p}>
    <path d="M5.4 11a3.2 3.2 0 0 1-.3-6.4 4.3 4.3 0 0 1 8.2-.9 3.6 3.6 0 0 1 .5 7.3z" />
    <path d="M7 14.2v3M5.7 15v1.4M8.3 15v1.4M13 14.2v3M11.7 15v1.4M14.3 15v1.4" />
  </Svg>
);

export const IconThunder = (p: Props) => (
  <Svg {...p}>
    <path d="M5.4 11a3.2 3.2 0 0 1-.3-6.4 4.3 4.3 0 0 1 8.2-.9 3.6 3.6 0 0 1 .5 7.3z" />
    <path d="M10.6 12.6 8 15.8h2.2l-.7 2.6 2.8-3.6h-2z" />
  </Svg>
);
