import { useEffect, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PvString } from "../../server/types.ts";
import { formatW } from "./format.ts";

/**
 * The page header: a low-poly house with its own weather.
 *
 * Built procedurally rather than loaded from a model, so it costs a few
 * hundred bytes and, more usefully, can be wired to the live system and the
 * live forecast. Roof panels brighten with real PV output; sun rays thin out
 * as real cloud cover rises; clouds drift in proportion to that cover; rain
 * falls when the forecast says it will; and at night the sun goes away.
 *
 * Everything is lit rather than filled: a key light, a cool fill and a
 * hemisphere give every facet its own value, which is what separates a solid
 * object from a blueprint of one. Architecture is carried by light, shadow,
 * and roof trim; only the solar panels retain their functional cell detail.
 *
 * Stops entirely for `prefers-reduced-motion` or a hidden tab.
 */

export interface HouseState {
  batteryW: number;
  gridW: number;
  acOutW: number;
  solarW: number;
  /** PV1..PV4, used to light their corresponding roof panel columns. */
  strings: PvString[];
  peakSolarW: number;
  /** Household draw, used for the outlet reading. */
  homeW: number;
  /** Mains coming in, for the run from the grid panel. */
  mainsW: number;
  /** AC output after measured socket demand, calculated without a Smart Meter. */
  netAcW: number | null;
  /** True when gridW is a verified Smart Meter measurement. */
  gridMeasured: boolean;
  /** Battery modules in the stack, which the cabinet is divided into. */
  packs: number;
}

export interface HouseWeather {
  cloudPct: number;
  precipPct: number;
  isDay: boolean;
  radiation: number;
  sunrise: string;
  sunset: string;
}

interface Palette {
  door: number;
  plinth: number;
  wall: number;
  roof: number;
  /** Ridge cap, fascia, rake boards, panel rails, conduit. */
  trim: number;
  /** The reveals around the door and window, which read as joinery. */
  frame: number;
  /** Window glazing. */
  glass: number;
  /** The wall-mounted battery. */
  bank: number;
  grid: number;
  /** Three tones, so the treeline is not one flat mass. */
  foliage: [number, number, number];
  trunk: number;
  cloud: number;
  /** The underside, which the crown is mixed down to. */
  cloudLow: number;
  fog: number;
  hemiSky: number;
  hemiGround: number;
  keyColor: number;
  keyIntensity: number;
  fillIntensity: number;
  hemiIntensity: number;
  /**
   * Panel sheen. Additive, so it has to be far weaker on the dark ground:
   * what reads as glass against a white wall turns the array milky at night.
   */
  gloss: number;
  /** Cast shadow and contact-blob strength, which differ a lot by ground tone. */
  shadow: number;
  contact: number;
}

const DARK: Palette = {
  door: 0x313c4c,
  plinth: 0x4a5869,
  wall: 0x8294ad,
  roof: 0x4c5f83,
  // Only a little under the roof: as a strong contrast the bands read as
  // gaps in the roof rather than as edges of it.
  trim: 0x455875,
  frame: 0x8192aa,
  glass: 0x6a91bf,
  bank: 0x2d3541,
  grid: 0x485463,
  foliage: [0x2d6048, 0x24513e, 0x356d51],
  trunk: 0x4a3d34,
  cloud: 0x3b4450,
  cloudLow: 0x2e3846,
  fog: 0x0c0d0f,
  hemiSky: 0x9fb8de,
  hemiGround: 0x0d0f13,
  keyColor: 0xfff1da,
  keyIntensity: 2.3,
  fillIntensity: 1.25,
  hemiIntensity: 1.15,
  gloss: 0.1,
  shadow: 0.5,
  contact: 0.55,
};

const LIGHT: Palette = {
  door: 0x9aa5b4,
  plinth: 0xd0d6df,
  wall: 0xffffff,
  roof: 0x6d84a8,
  trim: 0x647b9e,
  frame: 0xeef1f5,
  glass: 0xa9cbe8,
  bank: 0x8f97a3,
  grid: 0xc2c9d4,
  foliage: [0x6e9c81, 0x5d8b70, 0x7fae8d],
  trunk: 0xb2a89b,
  cloud: 0xffffff,
  cloudLow: 0x93a1b3,
  fog: 0xeceef1,
  hemiSky: 0xdce8f8,
  hemiGround: 0xc8cdd6,
  keyColor: 0xfff6e8,
  keyIntensity: 2.0,
  fillIntensity: 1.15,
  hemiIntensity: 1.5,
  gloss: 0.3,
  shadow: 0.22,
  contact: 0.3,
};

type Environment = Record<
  "sky" | "fog" | "ground" | "cloud" | "cloudLow",
  readonly [THREE.Color, THREE.Color, THREE.Color]
>;

const ENVIRONMENTS: Record<"dark" | "light", Environment> = {
  dark: {
    sky: [new THREE.Color(0x0c0d0f), new THREE.Color(0x111318), new THREE.Color(0x101214)],
    fog: [new THREE.Color(0x0c0d0f), new THREE.Color(0x101216), new THREE.Color(0x121315)],
    ground: [new THREE.Color(0x3c4450), new THREE.Color(0x5b4a4b), new THREE.Color(0x3e4248)],
    cloud: [new THREE.Color(0x68758b), new THREE.Color(0x8c757e), new THREE.Color(0x74787d)],
    cloudLow: [new THREE.Color(0x2e3846), new THREE.Color(0x46363e), new THREE.Color(0x464a50)],
  },
  light: {
    // Dusk dims the background rather than warming it. A warm sky and fog
    // stained the whole page pink for the last few hours of daylight, which
    // reads as a colour bug rather than as evening. Golden hour still lands,
    // but on the key light and the clouds - the things the sun is actually
    // striking.
    sky: [new THREE.Color(0xeceef1), new THREE.Color(0xe4e6ea), new THREE.Color(0x9da0a5)],
    fog: [new THREE.Color(0xeceef1), new THREE.Color(0xdcdee3), new THREE.Color(0xaeb1b5)],
    ground: [new THREE.Color(0xc2c9d4), new THREE.Color(0xd0d3d8), new THREE.Color(0xb4b7bb)],
    // Daylight crowns are white; only the undersides carry the grey.
    cloud: [new THREE.Color(0xffffff), new THREE.Color(0xf1f2f3), new THREE.Color(0x8d97a4)],
    cloudLow: [new THREE.Color(0x93a1b3), new THREE.Color(0xa2a7ae), new THREE.Color(0x4b5560)],
  },
};

const LIGHT_NIGHT_KEY = new THREE.Color(0xdce4ed);
const LIGHT_NIGHT_HEMI_SKY = new THREE.Color(0xd7dfe9);
const LIGHT_NIGHT_HEMI_GROUND = new THREE.Color(0x939aa3);
const DARK_NIGHT_KEY = new THREE.Color(0xc7cbcf);
const DARK_NIGHT_HEMI_SKY = new THREE.Color(0x8c9096);
const DARK_NIGHT_HEMI_GROUND = new THREE.Color(0x111315);
const DARK_NIGHT_WALL = new THREE.Color(0x687077);
const DARK_NIGHT_ROOF = new THREE.Color(0x363b41);
const DARK_NIGHT_TRIM = new THREE.Color(0x363c43);
const DARK_NIGHT_FRAME = new THREE.Color(0x737a82);
const DARK_NIGHT_PLINTH = new THREE.Color(0x3c4249);

const RAY_COUNT = 260;

/**
 * Sun shafts as actual line segments.
 *
 * They were point sprites, which are soft-edged and all one size, so they read
 * as rain. Lines give crisp edges and a real per-shaft length, and they can be
 * aimed: these spawn only in the column of sky above the roof, so the light
 * lands on the panels rather than across the whole scene.
 */
const RAY_VERT = /* glsl */ `
  /*
   * uPhase is integrated on the CPU as sum(dt * speed), NOT computed here as
   * time * speed. With the latter, every change to the speed rescaled all the
   * elapsed time at once, so the shafts lurched forward or snapped backward
   * whenever output moved. Integrating means a speed change only affects what
   * happens next.
   *
   * Each shaft is a quad, not a line. WebGL will not widen a line, so a
   * hairline is all a LineSegments can ever be - and a shaft of light with no
   * width and no soft edge cannot glow. The quad is turned to face the camera
   * here and given its falloff in the fragment.
   */
  uniform float uPhase;
  uniform float uAmount;
  uniform float uSlant;
  uniform float uTop;
  attribute float aSpan;
  attribute float aRate;
  attribute float aLen;
  attribute float aSeed;
  attribute float aEnd;
  attribute float aSide;
  attribute float aWidth;
  attribute float aBeam;
  varying float vBeam;
  varying float vFade;
  varying float vSide;
  varying float vHead;

  void main() {
    vSide = aSide;
    vBeam = aBeam;

    // Fixed threshold per shaft: as output rises, more of them are drawn.
    if (aSeed > uAmount) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float fall = mod(uTop - position.y + uPhase * (2.0 + aRate * 3.0), aSpan);
    fall = mix(fall, aSpan, aBeam);

    // Head of the shaft, drifting along the slant as it descends.
    vec3 head = vec3(position.x + fall * uSlant, uTop - fall, position.z);
    // Tail trails back up the same line, so the streak lies along its travel.
    vec3 dir = normalize(vec3(uSlant, -1.0, 0.0));
    vec3 p = head - dir * (aEnd * aLen);
    vHead = 1.0 - aEnd;

    // Faint high up, strongest just before it meets the panels, then cut off
    // at the roofline so nothing passes through the roof.
    float t = fall / aSpan;
    float approach = smoothstep(0.05, 0.88, t);
    float cutoff = smoothstep(1.0, 0.94, t);
    vFade = (0.18 + approach * 0.82) * cutoff;
    vFade = mix(vFade, 0.65 + 0.15 * sin(uPhase * 0.25 + aRate * 6.28), aBeam);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // Widen across the shaft in view space, so the quad always faces the
    // camera however the scene is tilted.
    vec3 dirView = normalize((modelViewMatrix * vec4(dir, 0.0)).xyz);
    vec2 across = normalize(vec2(-dirView.y, dirView.x));
    mv.xy += across * (aSide * aWidth * mix(1.0, mix(1.0, 0.3, aEnd), aBeam));

    gl_Position = projectionMatrix * mv;
  }
`;

const RAY_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  varying float vSide;
  varying float vHead;
  varying float vBeam;

  void main() {
    // Soft across the shaft, with a hot core: a flat band reads as a ribbon,
    // this reads as light.
    float across = 1.0 - abs(vSide);
    float body = pow(across, 1.7);
    float core = pow(across, 7.0);
    float lead = 0.75 + vHead * 0.45;
    float feather = smoothstep(0.0, 0.18, vHead) * (1.0 - smoothstep(0.98, 1.0, vHead));
    float alpha = mix((body * 0.72 + core * 0.9) * lead * 0.4, pow(across, 2.4) * feather * 1.8, vBeam);
    gl_FragColor = vec4(uColor * (1.0 + core * mix(1.4, 0.15, vBeam)), alpha * vFade * uOpacity);
  }
`;

const RAIN_VERT = /* glsl */ `
  uniform float uPhase;
  attribute float aRate;
  attribute float aLen;
  varying float vFade;

  void main() {
    vec3 p = position;
    float span = 26.0;
    p.y = 13.0 - mod(13.0 - p.y + uPhase * (2.0 + aRate * 3.0), span);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vFade = smoothstep(-2.5, 4.0, p.y) * smoothstep(34.0, 8.0, -mv.z);

    gl_PointSize = (2.2 / max(-mv.z, 0.001)) * 90.0 * aLen;
    gl_Position = projectionMatrix * mv;
  }
`;

const RAIN_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;

  void main() {
    vec2 q = gl_PointCoord - vec2(0.5);
    q.x *= 6.0;
    float d = length(q);
    if (d > 0.5) discard;
    gl_FragColor = vec4(uColor, smoothstep(0.5, 0.1, d) * vFade * uOpacity);
  }
`;

/**
 * Conduit that shows what is moving through it.
 *
 * A band travelling along the run, not a marching dash: soft head, longer
 * tail, so the eye picks up direction without the cable turning into a
 * barber's pole. TubeGeometry lays uv.x along the path, which is exactly the
 * coordinate the band needs, and uRepeat is set from the curve's real length
 * so a long run and a short one keep the same spacing.
 *
 * Unlit on purpose. These are 2.4cm tubes at this scale; shading them adds
 * nothing, and a flat base lets the glow be the only thing that reads.
 */
const CONDUIT_VERT = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const CONDUIT_FRAG = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform vec3 uBase;
  uniform vec3 uGlow;
  uniform float uPhase;
  uniform float uAmount;
  uniform float uRepeat;
  varying vec2 vUv;

  void main() {
    float t = fract(vUv.x * uRepeat - uPhase);
    float band = smoothstep(0.0, 0.1, t) * smoothstep(0.5, 0.16, t);
    gl_FragColor = vec4(mix(uBase, uGlow, band * uAmount), 1.0);
    // The same tail every other material gets. Without the colorspace
    // conversion a linear value lands in an sRGB target unconverted, which
    // is why the cable came out several stops darker than the trim it is
    // supposed to match.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** Which live figure drives each run, and the colour it glows. */
const FLOW_GLOW = {
  solar: 0x9bd5ff,
  grid: 0x9bd5ff,
  home: 0x9bd5ff,
} as const;

type FlowKey = keyof typeof FLOW_GLOW;

function roofPrism(width: number, height: number, depth: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  shape.lineTo(width / 2, 0);
  shape.lineTo(0, height);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

interface Limb {
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** Radius at a and at b: every limb tapers along its own length. */
  r0: number;
  r1: number;
}

interface Tip {
  at: THREE.Vector3;
  size: number;
}

/**
 * Foliage is many small clumps, never a few big ones.
 *
 * A handful of large blobs on bare limbs reads as a diagram of a tree. Real
 * canopy is dense enough that the eye reads a mass with light broken through
 * it, so the clumps stay small and are placed in quantity.
 */
const FOLIAGE_DETAIL = 1;

const UP = new THREE.Vector3(0, 1, 0);

/** A direction turned `spread` radians off `dir`, at `azimuth` around it. */
function branchOff(dir: THREE.Vector3, spread: number, azimuth: number): THREE.Vector3 {
  const ref = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : UP;
  const side = new THREE.Vector3().crossVectors(ref, dir).normalize();
  const other = new THREE.Vector3().crossVectors(dir, side);
  return dir
    .clone()
    .multiplyScalar(Math.cos(spread))
    .addScaledVector(side, Math.sin(spread) * Math.cos(azimuth))
    .addScaledVector(other, Math.sin(spread) * Math.sin(azimuth))
    .normalize();
}

/**
 * A broadleaf grown as an actual branch system.
 *
 * The thing that separates a tree from a lollipop is not the number of facets
 * on the crown - it is that the crown sits on a structure that visibly divides
 * and thins on the way up, and that the foliage gathers at the ends of that
 * structure rather than in one mass on a stick. So the trunk forks, each fork
 * forks again, every limb curves as it goes, and leaves are only ever placed
 * where a limb runs out.
 */
function growBroadleaf(random: () => number, extraBranches = 0): { limbs: Limb[]; tips: Tip[] } {
  const limbs: Limb[] = [];
  const tips: Tip[] = [];
  const MAX_DEPTH = 5;
  // Only some trees keep a low limb, and never more than two: it is the
  // variation that reads, not the feature. Without it every crown starts at
  // the same height off the stem and a stand of them looks issued.
  const lowWanted = random() < 0.65 ? 1 + Math.floor(random() * 2) : 0;
  let lowGrown = 0;

  const grow = (from: THREE.Vector3, dir: THREE.Vector3, length: number, radius: number, depth: number) => {
    const SEGMENTS = 4;
    const segLen = length / SEGMENTS;
    let p = from.clone();
    const d = dir.clone();

    for (let i = 0; i < SEGMENTS; i++) {
      d.lerp(UP, depth === 0 ? 0.03 : depth <= 2 ? 0.045 : 0.1).normalize();
      d.x += (random() - 0.5) * 0.16;
      d.z += (random() - 0.5) * 0.16;
      d.normalize();
      const next = p.clone().addScaledVector(d, segLen);
      limbs.push({
        a: p,
        b: next,
        r0: radius * (1 - (i / SEGMENTS) * 0.42),
        r1: radius * (1 - ((i + 1) / SEGMENTS) * 0.42),
      });
      p = next;

      // A limb straight off the trunk, wider-angled and lower than the fork.
      if (depth === 0 && i >= 1 && lowGrown < lowWanted && random() < 0.55) {
        lowGrown++;
        grow(
          p.clone(),
          branchOff(d, 0.72 + random() * 0.3, random() * Math.PI * 2),
          length * (0.66 + random() * 0.22),
          radius * 0.5,
          2,
        );
      }

      // The outer twigs carry leaves along their length, not only at the end,
      // and out to the sides of the limb rather than strung along its axis -
      // which is what gives the crown width instead of a bare core.
      // From the first fork out, and along the outer half of those - a limb
      // that carries nothing until its very tip reads as a bare stick with a
      // pom-pom on the end.
      if (depth >= 1 && i >= (depth === 1 ? 2 : 1)) {
        tips.push({ at: p.clone(), size: 0.14 + random() * 0.07 });
        const side = branchOff(d, Math.PI / 2, random() * Math.PI * 2);
        tips.push({
          at: p.clone().addScaledVector(side, 0.08 + random() * 0.11),
          size: 0.13 + random() * 0.07,
        });
      }
    }

    const endRadius = radius * 0.58;
    if (depth >= MAX_DEPTH || endRadius < 0.011) {
      tips.push({ at: p, size: 0.17 + random() * 0.08 });
      return;
    }

    const children = depth === 0 ? 3 : random() < 0.45 ? 3 : 2;
    for (let k = 0; k < children; k++) {
      const azimuth = (k / children) * Math.PI * 2 + random() * 0.9;
      const spread = (depth === 0 ? 0.95 : 0.7 - depth * 0.04) + random() * 0.26;
      grow(p, branchOff(d, spread, azimuth), length * (0.68 + random() * 0.14), endRadius, depth + 1);
    }
  };

  grow(new THREE.Vector3(0, 0, 0), UP.clone(), 0.86, 0.1, 0);
  const trunk = limbs.filter((limb) => limb.r0 > 0.055).slice(0, 4);
  for (let branch = 0; branch < extraBranches; branch++) {
    const base = trunk[trunk.length - 1]!;
    grow(base.b.clone(), branchOff(UP, 0.65 + branch * 0.08, branch * 2.4 + 0.7), 0.78 + branch * 0.04, 0.039, 1);
  }
  return { limbs, tips };
}

/**
 * A conifer: one leader the whole height, with whorls of branches off it.
 *
 * Stacked cones give the silhouette but nothing underneath it. Real branches
 * mean the profile breaks up, light gets between the tiers, and the trunk is
 * visible through the gaps the way it is on a real spruce.
 */
function growFir(random: () => number): { limbs: Limb[]; tips: Tip[] } {
  const limbs: Limb[] = [];
  const tips: Tip[] = [];
  const height = 4.2 + random() * 0.65;
  // Enough that consecutive tiers overlap: spaced wider than the foliage is
  // deep, the crown breaks into separate clumps with bare leader between them.
  const whorls = 15 + Math.floor(random() * 3);
  const base = 0.075;

  // The leader, tapering the whole way and wandering a little.
  const leader = new THREE.Vector3(0, 0, 0);
  const leaderDir = UP.clone();
  const steps = whorls + 2;
  const nodes: THREE.Vector3[] = [leader.clone()];
  for (let i = 0; i < steps; i++) {
    leaderDir.x += (random() - 0.5) * 0.035;
    leaderDir.z += (random() - 0.5) * 0.035;
    leaderDir.normalize();
    const next = leader.clone().addScaledVector(leaderDir, height / steps);
    limbs.push({
      a: leader.clone(),
      b: next,
      r0: base * (1 - i / steps) + 0.008,
      r1: base * (1 - (i + 1) / steps) + 0.008,
    });
    leader.copy(next);
    nodes.push(leader.clone());
  }
  // The leader is needled over its upper half, tapering to the point, so the
  // crown closes into a spire rather than ending in a knob.
  for (let i = Math.floor(nodes.length * 0.6); i < nodes.length; i++) {
    const k = (i - nodes.length * 0.6) / Math.max(nodes.length - nodes.length * 0.6, 1);
    tips.push({ at: nodes[i]!.clone(), size: (0.22 - k * 0.13) * (0.85 + random() * 0.3) });
  }

  /** A point anywhere along the leader, interpolated between its nodes. */
  const along = (u: number) => {
    const f = Math.max(0, Math.min(1, u)) * (nodes.length - 1);
    const i = Math.min(Math.floor(f), nodes.length - 2);
    return nodes[i]!.clone().lerp(nodes[i + 1]!, f - i);
  };

  // Whorls, longest low down and drooping more the lower they are.
  for (let w = 0; w < whorls; w++) {
    // Starts clear of the butt, so a grown tree shows some trunk, and runs to
    // the very top. Interpolated along the leader rather than snapped to its
    // nodes: rounding to the nearest node put two whorls on one node and left
    // the next node bare, which is where the gaps in the crown came from.
    const t = 0.18 + (w / Math.max(whorls - 1, 1)) * 0.8;
    const node = along(t);
    const armCount = 6 + Math.floor(random() * 3);
    const armLen = (1.18 * Math.pow(1 - t, 0.8) + 0.035) * (0.85 + random() * 0.3);
    const droop = 0.12 - (1 - t) * 0.35;

    for (let k = 0; k < armCount; k++) {
      const azimuth = (k / armCount) * Math.PI * 2 + w * 1.1 + random() * 0.5;
      const dir = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth))
        .normalize()
        .addScaledVector(UP, droop)
        .normalize();
      let p = node.clone();
      const SEG = 3;
      for (let i = 0; i < SEG; i++) {
        // Droops further along its length, under its own weight.
        dir.y -= 0.06;
        dir.normalize();
        const next = p.clone().addScaledVector(dir, armLen / SEG);
        limbs.push({
          a: p,
          b: next,
          r0: 0.02 * (1 - i / SEG) + 0.005,
          r1: 0.02 * (1 - (i + 1) / SEG) + 0.005,
        });
        p = next;
        // Needled the whole way out, not just at the end.
        tips.push({ at: p.clone(), size: (0.34 - t * 0.25) * (0.85 + random() * 0.3) });
      }
    }
  }

  return { limbs, tips };
}

/**
 * A shrub: several stems from one crown, each dividing once.
 *
 * Same machinery as the trees, kept low and multi-stemmed. Left as a single
 * smooth ball it was the one thing in the planting that still read as a
 * primitive once the trees around it had structure.
 */
function growBush(random: () => number): { limbs: Limb[]; tips: Tip[] } {
  const limbs: Limb[] = [];
  const tips: Tip[] = [];
  const stems = 4 + Math.floor(random() * 3);

  const grow = (from: THREE.Vector3, dir: THREE.Vector3, length: number, radius: number, depth: number) => {
    const SEGMENTS = 5;
    const segLen = length / SEGMENTS;
    let p = from.clone();
    const d = dir.clone();
    const bend = branchOff(dir, 0.65, random() * Math.PI * 2);
    for (let i = 0; i < SEGMENTS; i++) {
      d.lerp(bend, 0.2).lerp(UP, 0.045).normalize();
      d.x += (random() - 0.5) * 0.2;
      d.z += (random() - 0.5) * 0.2;
      d.normalize();
      const next = p.clone().addScaledVector(d, segLen);
      limbs.push({ a: p, b: next, r0: radius * (1 - (i / SEGMENTS) * 0.5), r1: radius * (1 - ((i + 1) / SEGMENTS) * 0.5) });
      p = next;
      if (depth > 0) tips.push({ at: p.clone(), size: 0.11 + random() * 0.06 });
    }
    if (depth >= 1) {
      tips.push({ at: p, size: 0.13 + random() * 0.07 });
      return;
    }
    const children = 2 + Math.floor(random() * 2);
    for (let k = 0; k < children; k++) {
      grow(
        p,
        branchOff(d, 0.5 + random() * 0.4, (k / children) * Math.PI * 2 + random()),
        length * 0.72,
        radius * 0.6,
        depth + 1,
      );
    }
  };

  for (let k = 0; k < stems; k++) {
    const azimuth = (k / stems) * Math.PI * 2 + random() * 0.8;
    const lean = 0.34 + random() * 0.3;
    grow(new THREE.Vector3(0, 0, 0), branchOff(UP, lean, azimuth), 0.38 + random() * 0.16, 0.028, 0);
  }
  return { limbs, tips };
}

/** Every limb as a tapered tube, merged into one mesh. */
function limbGeometry(limbs: Limb[], radial: number): THREE.BufferGeometry {
  const parts = limbs.map(({ a, b, r0, r1 }) => {
    const h = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(r1, r0, h, radial, 1);
    g.translate(0, h / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize()));
    g.translate(a.x, a.y, a.z);
    return g;
  });
  return mergeGeometries(parts)!;
}

/** Foliage clustered on the tips, merged into one mesh. */
function foliageGeometry(tips: Tip[], squash: number, random: () => number, plantScale = 1): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const tip of tips) {
    const size = tip.size * (0.72 + random() * 0.5);
    const height = squash * (0.85 + random() * 0.3);
    const offsetX = random();
    const offsetY = random();
    const offsetZ = random();
    let seed = Math.floor((offsetX + offsetY * 13 + offsetZ * 137) * 1_000_000);
    const leafRandom = () => THREE.MathUtils.seededRandom(seed++);
    const center = tip.at.clone().add(new THREE.Vector3(
      (offsetX - 0.5) * tip.size * 1.1,
      (offsetY - 0.5) * tip.size * 0.9,
      (offsetZ - 0.5) * tip.size * 1.1,
    ));
    const leafCount = squash < 0.6 ? 12 : Math.ceil(Math.min(96, Math.max(24, 24 * (size * plantScale / 0.22) ** 2)));
    for (let leaf = 0; leaf < leafCount; leaf++) {
      const angle = leaf * 2.399963 + offsetX * Math.PI * 2;
      const reach = size * Math.sqrt((leaf + 0.5) / leafCount);
      const origin = center.clone().add(new THREE.Vector3(
        Math.cos(angle) * reach,
        (leafRandom() - 0.5) * size * height * 1.6,
        Math.sin(angle) * reach,
      ));
      const length = squash < 0.6
        ? size * (0.9 + leafRandom() * 0.55) / plantScale
        : (0.12 + leafRandom() * 0.04) / plantScale;
      const width = length * (squash < 0.6 ? 0.22 : 0.42);
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        (leafRandom() - 0.5) * 1.8,
        angle,
        (leafRandom() - 0.5) * 1.2,
      ));
      const outline = [
        new THREE.Vector3(-length * 0.5, 0, 0),
        new THREE.Vector3(-length * 0.18, 0, width * 0.5),
        new THREE.Vector3(length * 0.22, 0, width * 0.4),
        new THREE.Vector3(length * 0.5, 0, 0),
        new THREE.Vector3(length * 0.22, 0, -width * 0.4),
        new THREE.Vector3(-length * 0.18, 0, -width * 0.5),
      ].map((vertex) => vertex.applyQuaternion(rotation).add(origin));
      const ridge = new THREE.Vector3(0, width * 0.16, 0).applyQuaternion(rotation).add(origin);
      for (let edge = 0; edge < outline.length; edge++) {
        for (const vertex of [ridge, outline[edge]!, outline[(edge + 1) % outline.length]!]) positions.push(...vertex);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A mitred ridge cap for a gable of this pitch, as one folded sheet.
 *
 * Inner boundary sits on the roof surface, outer boundary is offset off it,
 * and the two meet on the centreline above the apex. Two plates lying one on
 * each slope cannot do this: where they meet they leave a blunt flat instead
 * of a fold.
 */
function ridgeCap(eave: number, rise: number, depth: number, w = 0.05, run = 0.2): THREE.ExtrudeGeometry {
  const len = Math.hypot(eave, rise);
  const cosS = eave / len;
  const sinS = rise / len;
  const footX = run * cosS;
  const footY = rise - run * sinS;
  const outX = footX + w * sinS;
  const outY = footY + w * cosS;

  const shape = new THREE.Shape();
  shape.moveTo(footX, footY);
  shape.lineTo(0, rise);
  shape.lineTo(-footX, footY);
  shape.lineTo(-outX, outY);
  // Offsetting both slopes outward by w puts their intersection this far
  // above the apex.
  shape.lineTo(0, rise + w / cosS);
  shape.lineTo(outX, outY);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/**
 * The rake board for one gable end, as a single mitred chevron.
 *
 * Two boxes crossing at the apex could only either overlap - and their
 * coplanar gable faces then fight for depth - or stop short and leave a
 * notch. An extruded outline has a true mitre and neither problem.
 */
function rakeChevron(eave: number, rise: number, w = 0.1, over = 0.06, thickness = 0.08): THREE.ExtrudeGeometry {
  const len = Math.hypot(eave, rise);
  const cosS = eave / len;
  const sinS = rise / len;
  const half = w / 2;
  const apexOut = rise + half / cosS;
  const apexIn = rise - half / cosS;
  const footX = eave + over * cosS;
  const footY = -over * sinS;
  const outX = footX + half * sinS;
  const outY = footY + half * cosS;
  const inX = footX - half * sinS;
  const inY = footY - half * cosS;

  const shape = new THREE.Shape();
  shape.moveTo(outX, outY);
  shape.lineTo(0, apexOut);
  shape.lineTo(-outX, outY);
  shape.lineTo(-inX, inY);
  shape.lineTo(0, apexIn);
  shape.lineTo(inX, inY);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.translate(0, 0, -thickness / 2);
  return geo;
}

/**
 * The cell grid on a panel face, as clean quad lines.
 *
 * WireframeGeometry over a segmented plane would draw each triangle's
 * hypotenuse too, which reads as a lattice rather than photovoltaic cells.
 */
function cellGrid(w: number, h: number, cols: number, rows: number, y: number): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i <= cols; i++) {
    const x = -w / 2 + (w * i) / cols;
    pts.push(x, y, -h / 2, x, y, h / 2);
  }
  for (let j = 0; j <= rows; j++) {
    const z = -h / 2 + (h * j) / rows;
    pts.push(-w / 2, y, z, w / 2, y, z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/**
 * A soft round gradient, used as every object's contact shadow.
 *
 * A shadow map tight enough to keep the house crisp cannot also cover a plot
 * this wide, and one stretched over the whole plot turns every tree into a
 * grey smudge. So the map handles the house alone and each plant gets one of
 * these underneath instead - the same trick the reference app uses, and it
 * costs one texture for the entire scene.
 */
/**
 * The ground grid, as segments rather than full-width lines.
 *
 * THREE.GridHelper gives each line exactly two vertices, both out at the
 * plot's edge, so a per-vertex radial fade has nothing to interpolate across
 * and collapses to zero everywhere. Splitting every line at each cell gives
 * the fade somewhere to happen, and lets the fully faded cells be dropped
 * from the buffer entirely.
 */
function groundGrid(
  size: number,
  step: number,
  cx: number,
  cz: number,
  inner: number,
  outer: number,
): THREE.BufferGeometry {
  const half = size / 2;
  const pts: number[] = [];
  const cols: number[] = [];
  const fade = (x: number, z: number) =>
    1 - THREE.MathUtils.smoothstep(Math.hypot(x - cx, z - cz), inner, outer);

  const push = (x1: number, z1: number, x2: number, z2: number) => {
    const a1 = fade(x1, z1);
    const a2 = fade(x2, z2);
    if (a1 < 0.005 && a2 < 0.005) return;
    pts.push(x1, 0, z1, x2, 0, z2);
    cols.push(1, 1, 1, a1, 1, 1, 1, a2);
  };

  for (let i = -half; i <= half + 1e-6; i += step) {
    for (let j = -half; j < half - 1e-6; j += step) {
      push(i, j, i, j + step);
      push(j, i, j + step, i);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 4));
  return geo;
}

/**
 * A small gradient sky, for the panels to reflect.
 *
 * Glass only reads as glass when it has something to mirror. The key light
 * alone cannot do it here: every panel shares one normal, and the half-vector
 * between this camera and this sun sits about 37 degrees off it, so the
 * specular lobe never lands. The mirror direction, though, points almost
 * straight up - so a sky with a bright top and a horizon gives the whole
 * array a sheen, and the sun disc puts a glint in it.
 */
function skyTexture(): THREE.Texture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#dcecff");
  g.addColorStop(0.45, "#9fbcda");
  g.addColorStop(0.52, "#6c7f92");
  g.addColorStop(1, "#22262c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // The sun, placed where the key light actually is. Equirectangular maps
  // u from atan2(z, x) and v from asin(y), and the canvas is flipped in v.
  const dir = new THREE.Vector3(16, 15, 11).normalize();
  const u = Math.atan2(dir.z, dir.x) / (2 * Math.PI) + 0.5;
  const v = Math.asin(dir.y) / Math.PI + 0.5;
  const sun = ctx.createRadialGradient(u * w, (1 - v) * h, 0, u * w, (1 - v) * h, 18);
  sun.addColorStop(0, "rgba(255,255,255,1)");
  sun.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Straight runs joined by a small radius at each corner.
 *
 * A catmull-rom through the raw waypoints bows every run into a sag, which
 * reads as slack cable draped on the wall. Real conduit is set out in
 * straight lengths with a bend at each change of direction, so the corners
 * are filleted here and the curve is then fed through at zero tension, where
 * catmull-rom degenerates to exactly the polyline through its points.
 */
function routePath(pts: Array<[number, number, number]>, bend = 0.085): THREE.Vector3[] {
  const v = pts.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  if (v.length < 3) return v;

  const out: THREE.Vector3[] = [v[0]!.clone()];
  const STEPS = 5;
  for (let i = 1; i < v.length - 1; i++) {
    const prev = v[i - 1]!;
    const cur = v[i]!;
    const next = v[i + 1]!;
    const into = cur.clone().sub(prev);
    const away = next.clone().sub(cur);
    // Never eat more than a run is long, or short segments invert.
    const r = Math.min(bend, into.length() * 0.45, away.length() * 0.45);
    const a = cur.clone().addScaledVector(into.normalize(), -r);
    const b = cur.clone().addScaledVector(away.normalize(), r);
    out.push(a);
    for (let k = 1; k < STEPS; k++) {
      const t = k / STEPS;
      // Quadratic bezier a -> cur -> b.
      out.push(a.clone().lerp(cur, t).lerp(cur.clone().lerp(b, t), t));
    }
    out.push(b);
  }
  out.push(v[v.length - 1]!.clone());
  return out;
}

function contactTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(0,0,0,0.85)");
  g.addColorStop(0.45, "rgba(0,0,0,0.4)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function cloudParticleTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cloud = ctx.createRadialGradient(size / 2, size / 2, size * 0.04, size / 2, size / 2, size / 2);
  cloud.addColorStop(0, "rgba(255,255,255,0.78)");
  cloud.addColorStop(0.44, "rgba(255,255,255,0.54)");
  cloud.addColorStop(0.75, "rgba(255,255,255,0.18)");
  cloud.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = cloud;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const CLOUD_VERT = /* glsl */ `
  varying vec3 vLocal;

  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOUD_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uLow;
  uniform float uShade;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uSeed;
  uniform vec3 uCamera;
  uniform vec3 uBounds;
  uniform vec3 uSquash;
  uniform vec2 uCut;
  uniform vec3 uOctaves;
  varying vec3 vLocal;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z
    );
  }

  float density(vec3 p) {
    vec3 q = p / uBounds;
    // uSquash and uCut are per lobe: the same box can hold a tight puff or a
    // long torn wisp, which is what stops a sky of them reading as one shape
    // stamped over and over.
    vec3 shapeP = q * uSquash;
    float shape = 1.0 - smoothstep(uCut.x, uCut.y, length(shapeP));
    vec3 wind = vec3(uTime * 0.012 + uSeed, 0.0, uTime * 0.006);
    float detail =
      noise(q * 3.0 + wind) * uOctaves.x +
      noise(q * 6.5 - wind * 1.7) * uOctaves.y +
      noise(q * 12.0 + wind * 0.4) * uOctaves.z;
    return smoothstep(0.38, 0.7, detail + shape * 0.58) * shape;
  }

  vec2 hitBox(vec3 ro, vec3 rd) {
    vec3 inv = 1.0 / rd;
    vec3 t0 = (-uBounds - ro) * inv;
    vec3 t1 = (uBounds - ro) * inv;
    vec3 lo = min(t0, t1);
    vec3 hi = max(t0, t1);
    return vec2(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
  }

  void main() {
    vec3 ray = normalize(vLocal - uCamera);
    vec2 hit = hitBox(uCamera, ray);
    float near = max(hit.x, 0.0);
    float far = hit.y;
    if (far <= near) discard;

    float stepSize = (far - near) / 28.0;
    float transmittance = 1.0;
    float alpha = 0.0;
    float brightness = 0.0;
    for (int i = 0; i < 28; i++) {
      vec3 samplePoint = uCamera + ray * (near + (float(i) + 0.5) * stepSize);
      float amount = density(samplePoint);
      float vertical = samplePoint.y / uBounds.y;
      float light = 0.42 + (vertical + 1.0) * 0.28;
      float absorb = amount * stepSize * 2.0 * uOpacity;
      float contribution = transmittance * absorb;
      alpha += contribution;
      brightness += contribution * light;
      transmittance *= 1.0 - absorb;
      if (transmittance < 0.025) break;
    }
    if (alpha < 0.012) discard;
    // brightness/alpha is the ray average of the vertical light term, which
    // runs 0.42 at the underside to 0.98 at the crown. Normalised, it is the
    // mix between the two tones - so the gradient is carried by real colours,
    // not by scaling one, which could only ever make grey into lighter grey.
    float lift = clamp((brightness / alpha - 0.42) / 0.56, 0.0, 1.0);
    // Biased toward the crown: the ray average is pulled down by the dense
    // middle, so an unweighted mix leaves the whole cloud sitting near the
    // underside tone.
    lift = pow(lift, 0.88);
    gl_FragColor = vec4(mix(uLow, uTop, lift) * uShade, min(alpha, 0.82));
    // The same tail every built-in material gets. Without the colour-space
    // conversion a linear value lands in an sRGB target unconverted, which
    // renders every tone well below the one the palette asked for - which is
    // what was turning white crowns grey.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function HouseScene({ state, weather }: { state: HouseState; weather: HouseWeather | null }) {
  const hostRef = useRef<HTMLDivElement>(null);

  const gridImporting = state.gridW >= 0;
  const sourceLabel = state.gridMeasured
    ? gridImporting
      ? "Grid in"
      : "Grid out"
    : state.netAcW === null
      ? "AC input"
      : state.netAcW >= 0
        ? "Net AC out"
        : "Net AC in";
  const sourceW = state.gridMeasured ? Math.abs(state.gridW) : state.netAcW === null ? state.mainsW : Math.abs(state.netAcW);
  const metrics = [
    { label: "Solar", value: formatW(state.solarW), tone: "solar", spot: "roof" },
    { label: "Home", value: formatW(state.homeW), tone: "home", spot: "home" },
    { label: "Battery", value: formatW(Math.abs(state.batteryW)), tone: "battery", spot: "battery" },
    { label: sourceLabel, value: formatW(sourceW), tone: "grid", spot: "service" },
    { label: "AC output", value: formatW(Math.abs(state.acOutW)), tone: "output", spot: "output" },
  ];
  const metricsRef = useRef(metrics);
  const targetRef = useRef({
    solar: 0,
    strings: Array.from({ length: 4 }, () => 0),
    speed: 0.3,
    cloud: 0.3,
    rain: 0,
    day: 1,
    dusk: 0,
    flow: { solar: 0, grid: 0, home: 0 } as Record<FlowKey, number>,
    direction: { solar: 1, grid: 1, home: 1 } as Record<FlowKey, number>,
    packs: 1,
  });

  useEffect(() => {
    const { batteryW, gridW, acOutW, solarW, strings, peakSolarW, homeW, mainsW, netAcW, gridMeasured, packs } = state;
    const magnitude = Math.max(Math.abs(batteryW), Math.abs(gridW), solarW);
    const expectedStringW = Math.max(peakSolarW / Math.max(strings.length, 1), 300);
    const totalSolarLevel = Math.min(solarW / Math.max(peakSolarW, 800), 1);
    const sunriseMs = weather ? new Date(weather.sunrise).getTime() : NaN;
    const sunsetMs = weather ? new Date(weather.sunset).getTime() : NaN;
    const daylightProgress =
      Number.isFinite(sunriseMs) && Number.isFinite(sunsetMs) && sunsetMs > sunriseMs
        ? Math.min(1, Math.max(0, (Date.now() - sunriseMs) / (sunsetMs - sunriseMs)))
        : 0;
    targetRef.current = {
      solar: totalSolarLevel,
      strings: Array.from({ length: 4 }, (_, index) => {
        const string = strings[index];
        return string ? Math.min(Math.max(string.watts, 0) / expectedStringW, 1) : totalSolarLevel;
      }),
      speed: 0.2 + Math.min(magnitude / 2500, 1) * 0.5,
      cloud: weather ? weather.cloudPct / 100 : 0.3,
      // Only actually raining above a meaningful probability.
      rain: weather && weather.precipPct >= 40 ? Math.min((weather.precipPct - 40) / 50, 1) : 0,
      day: weather ? (weather.isDay ? 1 : 0) : 1,
      // A long ease into golden hour avoids a theatrical colour jump.
      dusk: weather?.isDay ? Math.min(1, Math.max(0, (daylightProgress - 0.82) / 0.18)) : 0,
      // Below 5 W is noise, so the run stays dark rather than trickling. Above
      // it the band starts well up the range: against a white wall a faint
      // one is indistinguishable from the cable's own colour.
      flow: {
        solar: solarW >= 5 ? Math.min(0.55 + solarW / 2400, 1) : 0,
        grid: gridMeasured
          ? Math.abs(gridW) >= 5
            ? Math.min(0.55 + Math.abs(gridW) / 1800, 1)
            : 0
          : netAcW !== null && Math.abs(netAcW) >= 5
            ? Math.min(0.55 + Math.abs(netAcW) / 1800, 1)
            : 0,
        // Socket-mode AC output is the Solarbank feed to the measured plugs;
        // it is not a verified export reading until a Smart Meter is present.
        home: Math.abs(acOutW) >= 5 ? Math.min(0.55 + Math.abs(acOutW) / 1800, 1) : 0,
      },
      direction: {
        solar: 1,
        // Positive Smart Meter readings import from grid to bank; negative
        // readings export. Socket mode derives the same direction from the
        // output remaining after measured socket demand.
        grid: gridMeasured ? (gridW < -5 ? -1 : 1) : netAcW !== null && netAcW > 5 ? -1 : 1,
        // This route is modelled bank -> outlet, the known AC-output path.
        home: 1,
      },
      packs,
    };
  }, [state, weather]);

  useEffect(() => {
    metricsRef.current = metrics;
  }, [metrics]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    // A filmic roll-off, so a panel driven hard by real output saturates into
    // warm light rather than clipping to a flat block of colour.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    // PCFSoft is deprecated and silently falls back to PCF anyway; asking
    // for PCF directly and widening the kernel gets the soft edge back.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Nothing that casts a shadow ever moves, so the map is rendered once
    // instead of every frame.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    host.appendChild(renderer.domElement);
    let sceneRevealed = false;

    const scene = new THREE.Scene();
    const fog = new THREE.Fog(0x0c0d0f, 20, 44);
    scene.fog = fog;
    const skyColor = new THREE.Color(0x0c0d0f);
    scene.background = skyColor;
    const BASE_FOV = 33;
    const BASE_SCENE_HEIGHT = 640;
    const camera = new THREE.PerspectiveCamera(BASE_FOV, host.clientWidth / host.clientHeight, 0.1, 200);
    // Three-quarter from above: we see the panelled slope and one gable end,
    // meeting at the front corner. Held as an orbit about the subject so the
    // pointer tilt can lean it without the framing drifting off.
    const LOOK = new THREE.Vector3(1.6, 2.0, 0.6);
    const mobileLook = new THREE.Vector3(3.3, 2.0, -0.8);
    const viewTarget = LOOK.clone();
    const HOME = new THREE.Vector3(11.6, 8.0, 12.8);
    const orbit = HOME.clone().sub(LOOK);
    const ORBIT_R = orbit.length();
    const BASE_YAW = Math.atan2(orbit.x, orbit.z);
    const BASE_PITCH = Math.asin(orbit.y / ORBIT_R);
    const aimCamera = (yaw: number, pitch: number) => {
      const cp = Math.cos(pitch);
      camera.position.set(
        viewTarget.x + ORBIT_R * cp * Math.sin(yaw),
        viewTarget.y + ORBIT_R * Math.sin(pitch),
        viewTarget.z + ORBIT_R * cp * Math.cos(yaw),
      );
      camera.lookAt(viewTarget);
    };
    aimCamera(BASE_YAW, BASE_PITCH);

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    let pal = document.documentElement.dataset["theme"] === "light" ? LIGHT : DARK;
    let environment = pal === LIGHT ? ENVIRONMENTS.light : ENVIRONMENTS.dark;

    // ---------------- light ----------------
    // The key sits on the camera's side of the house so the gable end and the
    // panelled slope are both lit, and the cast shadow falls away behind. A
    // key from the other side put the gable - half the visible silhouette -
    // into flat darkness.
    const hemi = new THREE.HemisphereLight(pal.hemiSky, pal.hemiGround, pal.hemiIntensity);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(pal.keyColor, pal.keyIntensity);
    key.position.set(8, 15, 18);
    key.target.position.set(4, 1.6, -1);
    key.castShadow = true;
    const shadowResolution = Math.min(4096, renderer.capabilities.maxTextureSize);
    key.shadow.mapSize.set(shadowResolution, shadowResolution);
    key.shadow.radius = 9;
    const sc = key.shadow.camera;
    sc.left = -9;
    sc.right = 9;
    sc.top = 9;
    sc.bottom = -9;
    sc.near = 1;
    sc.far = 46;
    sc.updateProjectionMatrix();
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.02;
    scene.add(key, key.target);
    const dayKeyPosition = key.position.clone();
    const duskKeyPosition = new THREE.Vector3(13, 5.5, 10);
    const duskKeyColor = new THREE.Color(0xffeedc);

    // Cool counter-light on the shaded faces, so they read as turned away
    // from the sun rather than as holes.
    const fill = new THREE.DirectionalLight(0x9dbce8, pal.fillIntensity);
    const dayFillColor = fill.color.clone();
    const nightFillColor = new THREE.Color(0xbfc2c6);
    fill.position.set(-11, 7, -6);
    scene.add(fill);

    // ---------------- materials ----------------
    const surface = (color: number, roughness = 0.92) =>
      track(new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, fog: true }));

    const wallMat = surface(pal.wall, 0.95);
    const roofMat = surface(pal.roof, 0.8);
    const trunkMat = surface(pal.trunk);
    const plinthMat = surface(pal.plinth);
    const doorMat = surface(pal.door, 0.6);
    const trimMat = surface(pal.trim, 0.78);
    const frameMat = surface(pal.frame, 0.85);
    const glassMat = track(
      new THREE.MeshStandardMaterial({
        color: pal.glass,
        roughness: 0.12,
        metalness: 0.1,
        fog: true,
      }),
    );
    const bankMat = surface(pal.bank, 0.55);
    // Flat shading is what makes a six-sided cone read as low-poly rather
    // than as a badly tessellated smooth one.
    const foliageMats = pal.foliage.map((c) =>
      track(new THREE.MeshStandardMaterial({ color: c, roughness: 0.98, metalness: 0, flatShading: true, side: THREE.DoubleSide })),
    );

    /** Architecture: filled surfaces, shaped by the scene lighting. */
    const shell = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };

    /** Planting: no edges. Lighting and facets carry the form. */
    const solidMesh = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      return m;
    };

    // ---------------- house, sitting right of centre ----------------
    const house = new THREE.Group();
    house.rotation.y = -Math.PI / 2;
    // Lifted a hair so the plinth's bottom edges draw above the grid instead
    // of z-fighting with it and disappearing.
    house.position.set(4.0, 0.015, -1.0);
    scene.add(house);

    const EAVE = 1.72;
    const RISE = 1.45;
    const BASE = 2.4;
    const RIDGE = 0.26 + BASE + RISE;

    const PLINTH = 0.26;

    const slopeLen = Math.hypot(EAVE, RISE);
    const cosS = EAVE / slopeLen;
    const sinS = RISE / slopeLen;

    // One slab under house and garage both. Two boxes met in a visible seam
    // with a step where their depths disagreed.
    //
    // Snapped to the grid: the house sits at world (4, -1) with a quarter
    // turn, so local z maps to world x and local x to world z. Integer local
    // bounds therefore land on integer world coordinates, which is where the
    // grid lines are. Local x -3..3 gives world z -4..2; local z -4..7 gives
    // world x -3..8. It clears the roof line by about a unit all round.
    const SLAB_X0 = -3;
    const SLAB_X1 = 3;
    const SLAB_Z0 = -4;
    const SLAB_Z1 = 7;
    const baseGeo = track(
      new THREE.BoxGeometry(SLAB_X1 - SLAB_X0, PLINTH, SLAB_Z1 - SLAB_Z0),
    );
    baseGeo.translate((SLAB_X0 + SLAB_X1) / 2, PLINTH / 2, (SLAB_Z0 + SLAB_Z1) / 2);
    house.add(shell(baseGeo, plinthMat));

    const wallGeo = track(new THREE.BoxGeometry(3.0, BASE, 5.0));
    wallGeo.translate(0, PLINTH + BASE / 2, 0);
    house.add(shell(wallGeo, wallMat));

    const roofGeo = track(roofPrism(EAVE * 2, RISE, 5.4));
    roofGeo.translate(0, PLINTH + BASE, 0);
    house.add(shell(roofGeo, roofMat));

    // Roof edges. A bare extruded prism reads as a folded card; a real roof
    // is banded at every edge it terminates on, and those bands are what the
    // eye uses to place the pitch. All in the roof material: as a separate
    // colour they read as inlays cut into the roof rather than parts of it.
    const ROOF_D = 5.4;
    const roofTrim = new THREE.Group();
    house.add(roofTrim);

    // No edge lines on these. Six banded pieces each carrying its own
    // wireframe was most of what made the roof read as fussy; the bands are
    // already separated by the light.
    const addTrim = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rz = 0) => {
      const m = new THREE.Mesh(track(geo), roofMat);
      m.position.set(x, y, z);
      m.rotation.z = rz;
      m.castShadow = true;
      m.receiveShadow = true;
      roofTrim.add(m);
    };

    // Ridge cap. Stops inside the rake board, so its end grain is never
    // on show.
    {
      const geo = track(ridgeCap(EAVE, RISE, ROOF_D + 0.12));
      geo.translate(0, PLINTH + BASE, 0);
      const m = new THREE.Mesh(geo, roofMat);
      m.castShadow = true;
      m.receiveShadow = true;
      roofTrim.add(m);
    }

    // Fascia. Hung below the eave and slightly proud, the way a fascia board
    // actually sits. Centred on the eave corner it straddled the arris and
    // read as a band inset into the roof.
    for (const side of [-1, 1]) {
      addTrim(
        new THREE.BoxGeometry(0.12, 0.14, ROOF_D + 0.24),
        side * (EAVE + 0.04),
        PLINTH + BASE - 0.06,
        0,
      );
    }

    // Rake boards on both gable ends.
    {
      const geo = track(rakeChevron(EAVE, RISE));
      geo.translate(0, PLINTH + BASE, 0);
      for (const end of [-1, 1]) {
        const m = new THREE.Mesh(geo, roofMat);
        m.position.z = end * (ROOF_D / 2 + 0.04);
        m.castShadow = true;
        m.receiveShadow = true;
        roofTrim.add(m);
      }
    }

    /**
     * Standing seams up both slopes: the complexity the roof was missing, and
     * what makes it read as folded metal sheet rather than one cast surface.
     * One instanced mesh per roof, so it stays a single draw call. They sit
     * lower than the panels stand off, so the array passes clear over them.
     */
    const addSeams = (eave: number, rise: number, depth: number, baseY: number, centreZ: number) => {
      const SEAM_GAP = 0.9;
      const perSlope = Math.floor(depth / SEAM_GAP);
      const len = Math.hypot(eave, rise);
      const cs = eave / len;
      const sn = rise / len;
      const geo = track(new THREE.BoxGeometry(len - 0.14, 0.04, 0.04));
      const mesh = new THREE.InstancedMesh(geo, roofMat, perSlope * 2);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const one = new THREE.Vector3(1, 1, 1);
      let i = 0;
      for (const side of [-1, 1]) {
        // Outward normal of this slope, to lift the rib clear of the surface.
        const nx = side * sn;
        const ny = cs;
        for (let k = 0; k < perSlope; k++) {
          q.setFromEuler(new THREE.Euler(0, 0, Math.atan2(rise, -side * eave)));
          pos.set(
            (side * eave) / 2 + nx * 0.021,
            baseY + rise / 2 + ny * 0.021,
            centreZ - depth / 2 + SEAM_GAP * (k + 0.5),
          );
          m.compose(pos, q, one);
          mesh.setMatrixAt(i++, m);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      roofTrim.add(mesh);
      disposables.push(mesh);
    };

    addSeams(EAVE, RISE, ROOF_D, PLINTH + BASE, 0);

    // Door and window share a head height, as they would on a real elevation.
    const DOOR_H = 1.35;
    const WIN_H = 0.66;
    const HEAD = PLINTH + DOOR_H;

    // Both openings are built the same way: a trim plate set into the wall,
    // then the leaf or the glass proud of it, so a band of frame shows all
    // the way round instead of a flat rectangle painted on the render.
    const WALL_FACE = 1.5;
    /** The gable elevation, which faces the camera's right. */
    const GABLE_FACE = -2.5;
    const openings = new THREE.Group();
    house.add(openings);

    const addPlate = (h: number, w: number, y: number, z: number) => {
      const geo = track(new THREE.BoxGeometry(0.05, h + 0.14, w + 0.14));
      geo.translate(WALL_FACE + 0.005, y, z);
      openings.add(shell(geo, frameMat));
    };

    const DOOR_Z = 0.95;
    const WIN_Z = -0.55;
    const WIN_Y = HEAD - WIN_H / 2;

    addPlate(DOOR_H, 0.72, PLINTH + DOOR_H / 2, DOOR_Z);
    const doorGeo = track(new THREE.BoxGeometry(0.06, DOOR_H, 0.72));
    doorGeo.translate(WALL_FACE + 0.02, PLINTH + DOOR_H / 2, DOOR_Z);
    openings.add(shell(doorGeo, doorMat));

    // Handle, on the leading edge at the height a handle actually sits.
    const handleGeo = track(new THREE.BoxGeometry(0.05, 0.055, 0.055));
    handleGeo.translate(WALL_FACE + 0.06, PLINTH + DOOR_H * 0.46, DOOR_Z - 0.26);
    openings.add(new THREE.Mesh(handleGeo, frameMat));

    const addWindow = (z: number) => {
      addPlate(WIN_H, 0.82, WIN_Y, z);
      const geo = track(new THREE.BoxGeometry(0.06, WIN_H, 0.82));
      geo.translate(WALL_FACE + 0.02, WIN_Y, z);
      openings.add(shell(geo, glassMat));

      // A mullion and a transom, which is what stops the glass reading as a
      // dark rectangle at this size.
      const mullion = track(new THREE.BoxGeometry(0.05, WIN_H, 0.045));
      mullion.translate(WALL_FACE + 0.045, WIN_Y, z);
      openings.add(new THREE.Mesh(mullion, frameMat));
      const transom = track(new THREE.BoxGeometry(0.05, 0.045, 0.82));
      transom.translate(WALL_FACE + 0.045, WIN_Y, z);
      openings.add(new THREE.Mesh(transom, frameMat));
    };

    addWindow(WIN_Z);

    /** The same opening turned onto the gable, where local x runs across. */
    const addGableWindow = (x: number) => {
      const plate = track(new THREE.BoxGeometry(0.82 + 0.14, WIN_H + 0.14, 0.05));
      plate.translate(x, WIN_Y, GABLE_FACE - 0.005);
      openings.add(shell(plate, frameMat));

      const geo = track(new THREE.BoxGeometry(0.82, WIN_H, 0.06));
      geo.translate(x, WIN_Y, GABLE_FACE - 0.02);
      openings.add(shell(geo, glassMat));

      const mullion = track(new THREE.BoxGeometry(0.045, WIN_H, 0.05));
      mullion.translate(x, WIN_Y, GABLE_FACE - 0.045);
      openings.add(new THREE.Mesh(mullion, frameMat));
      const transom = track(new THREE.BoxGeometry(0.82, 0.045, 0.05));
      transom.translate(x, WIN_Y, GABLE_FACE - 0.045);
      openings.add(new THREE.Mesh(transom, frameMat));
    };

    // On the gable, clear of the grid panel at x 0.57 to 0.93.
    addGableWindow(-0.5);

    // ---------------- garage, on the far gable ----------------
    // Local +z is world -x, which is screen left. Flat roofed, which also
    // frees its height: a pitched one had to stay shallow to duck under the
    // house eave, and even then could not come near the house's 40 degrees.
    const GAR_D = 3.2;
    const GAR_H = 1.95;
    const GAR_HALF = 1.66;
    const GAR_Z = 2.5 + GAR_D / 2;
    // Square to the house wall at one end, overhanging only at the far one.
    const GAR_ROOF_Z0 = 2.5;
    const GAR_ROOF_Z1 = 2.5 + GAR_D + 0.3;
    const GAR_ROOF_D = GAR_ROOF_Z1 - GAR_ROOF_Z0;
    const GAR_ROOF_C = (GAR_ROOF_Z0 + GAR_ROOF_Z1) / 2;

    const garWallGeo = track(new THREE.BoxGeometry(3.0, GAR_H, GAR_D));
    garWallGeo.translate(0, PLINTH + GAR_H / 2, GAR_Z);
    house.add(shell(garWallGeo, wallMat));

    // The deck, and a coping band lipped over its edge.
    const garRoofGeo = track(new THREE.BoxGeometry(GAR_HALF * 2, 0.14, GAR_ROOF_D));
    garRoofGeo.translate(0, PLINTH + GAR_H + 0.07, GAR_ROOF_C);
    house.add(solidMesh(garRoofGeo, roofMat));

    const garCopeGeo = track(new THREE.BoxGeometry(GAR_HALF * 2 + 0.07, 0.05, GAR_ROOF_D + 0.07));
    garCopeGeo.translate(0, PLINTH + GAR_H + 0.15, GAR_ROOF_C + 0.035);
    house.add(solidMesh(garCopeGeo, roofMat));

    // The door: wide, low, and ribbed, so it is not mistaken for the one on
    // the house.
    const GAR_DOOR_W = 2.1;
    const GAR_DOOR_H = 1.5;
    const garPlateGeo = track(new THREE.BoxGeometry(0.05, GAR_DOOR_H + 0.16, GAR_DOOR_W + 0.16));
    garPlateGeo.translate(WALL_FACE + 0.005, PLINTH + GAR_DOOR_H / 2, GAR_Z);
    house.add(shell(garPlateGeo, frameMat));

    const garDoorGeo = track(new THREE.BoxGeometry(0.06, GAR_DOOR_H, GAR_DOOR_W));
    garDoorGeo.translate(WALL_FACE + 0.02, PLINTH + GAR_DOOR_H / 2, GAR_Z);
    house.add(shell(garDoorGeo, doorMat));

    for (let i = 1; i < 5; i++) {
      const rib = track(new THREE.BoxGeometry(0.05, 0.035, GAR_DOOR_W));
      rib.translate(WALL_FACE + 0.045, PLINTH + (GAR_DOOR_H * i) / 5, GAR_Z);
      house.add(new THREE.Mesh(rib, frameMat));
    }

    // ---------------- solar panels on the slope ----------------    // ---------------- solar panels on the slope ----------------

    const PANEL_W = 0.86;
    const PANEL_H = 1.06;
    const PANEL_GAP = 0.12;
    const PANEL_T = 0.055;
    /** Standoff between the roof surface and the underside of the panel. */
    const PANEL_LIFT = 0.075;
    // Puts the two rows centrally on the slope, leaving a margin at the ridge
    // and at the eave close to the gap between them.
    const SLOPE_START = 0.64;

    // Dark blue glass, and it stays that colour. Output is carried by a cool
    // lift in the glass and by the cell lines picking up, never by a hue
    // change - an array that turns amber under load stops reading as glass.
    const panelMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x16233a,
        roughness: 0.14,
        metalness: 0.35,
        emissive: new THREE.Color(0x3f78bd),
        emissiveIntensity: 0,
        side: THREE.DoubleSide,
      }),
    );
    const cellMat = track(
      new THREE.LineBasicMaterial({ color: 0x9dc0ea, transparent: true, opacity: 0.22 }),
    );
    const panelEdgeMat = track(
      new THREE.LineBasicMaterial({ color: 0xbcd4ee, transparent: true, opacity: 0.45 }),
    );

    // Prefiltered once at startup and attached to the panels alone, rather
    // than to scene.environment, so no other material's response changes.
    {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const sky = skyTexture();
      const target = pmrem.fromEquirectangular(sky);
      panelMat.envMap = target.texture;
      panelMat.envMapIntensity = 0.85;
      disposables.push(target);
      sky.dispose();
      pmrem.dispose();
    }

    // A slab, not a plane. The side faces catch the light at a different
    // angle from the top, which is what reads as thickness, and the gap to
    // the roof lets the array drop a shadow onto it.
    const tilt = -Math.asin(sinS);
    const glossUniform = { value: pal.gloss };
    const glintUniform = { value: 0 };
    const glintClock = { value: 0 };
    const glintLife = { value: [0, 0, 0] };
    const RAY_SLANT = 0.42;
    const sunDirection = new THREE.Vector3(-Math.tan(RAY_SLANT), 1, 0).normalize();
    const sunHits = { value: Array.from({ length: 3 }, () => new THREE.Vector3()) };
    panelMat.onBeforeCompile = (shader) => {
      shader.uniforms["uGloss"] = glossUniform;
      shader.uniforms["uGlint"] = glintUniform;
      shader.uniforms["uGlintLife"] = glintLife;
      shader.uniforms["uSunDirection"] = { value: sunDirection };
      shader.uniforms["uSunHits"] = sunHits;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec2 vGlassUv;
          varying vec3 vGlassWorld;
          varying vec3 vGlassNormal;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vGlassUv = uv;
          vGlassWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
          vGlassNormal = normalize( mat3( modelMatrix ) * normal );`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uGloss;
          uniform float uGlint;
          uniform float uGlintLife[3];
          uniform vec3 uSunDirection;
          uniform vec3 uSunHits[3];
          varying vec2 vGlassUv;
          varying vec3 vGlassWorld;
          varying vec3 vGlassNormal;`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
          {
            vec3 glassNormal = normalize( vGlassNormal );
            vec3 glassView = normalize( cameraPosition - vGlassWorld );
            vec3 reflectedSun = reflect( -uSunDirection, glassNormal );
            float facing = max( dot( glassNormal, uSunDirection ), 0.0 );
            float specularView = pow( max( dot( reflectedSun, glassView ), 0.0 ), 12.0 );
            float sheenAxis = dot( vGlassUv - vec2(0.5), vec2(0.8, 0.6) ) +
              dot( glassView, vec3(0.9, 0.0, 0.75) ) - 0.55;
            float sheen = exp( -sheenAxis * sheenAxis * 9.0 );
            float broadReflection = pow( max( dot( reflectedSun, glassView ), 0.0 ), 3.0 );
            totalEmissiveRadiance += vec3(0.35, 0.48, 0.65) * sheen * uGloss *
              (0.2 + broadReflection * 0.8) * facing * uGlint * 0.65;
            for ( int hit = 0; hit < 3; hit++ ) {
              vec3 offset = vGlassWorld - uSunHits[hit];
              float distanceSq = dot( offset, offset );
              float core = exp( -distanceSq * 500.0 );
              totalEmissiveRadiance += vec3( 1.0, 0.95, 0.84 ) *
                core * 1.6 * (0.08 + specularView) * facing * uGlintLife[hit] * uGlint;
            }
          }`,
        );
    };

    // Each roof column is one physical PV string. The shader's reflection
    // uniform stays shared, while output intensity is independent per bank.
    const panelBanks = Array.from({ length: 4 }, () => {
      const face = track(panelMat.clone());
      face.onBeforeCompile = panelMat.onBeforeCompile;
      return {
        face,
        cells: track(cellMat.clone()),
        edges: track(panelEdgeMat.clone()),
      };
    });

    const panelGeo = track(new THREE.BoxGeometry(PANEL_W, PANEL_T, PANEL_H));
    panelGeo.rotateZ(tilt);
    const panelEdges = track(new THREE.EdgesGeometry(panelGeo));

    const cellGeo = track(cellGrid(PANEL_W, PANEL_H, 3, 4, PANEL_T / 2 + 0.002));
    cellGeo.rotateZ(tilt);

    // Two stubby rails under each panel, so it stands off the roof on
    // something rather than floating.
    const railGeo = track(new THREE.BoxGeometry(0.09, PANEL_LIFT, PANEL_H * 0.44));
    railGeo.translate(0, -PANEL_T / 2 - PANEL_LIFT / 2, 0);
    railGeo.rotateZ(tilt);

    const panels = new THREE.Group();
    house.add(panels);

    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 2; row++) {
        const p = new THREE.Group();
        const bank = panelBanks[col]!;
        const face = new THREE.Mesh(panelGeo, bank.face);
        face.castShadow = true;
        face.receiveShadow = true;
        for (const side of [-1, 1]) {
          const rail = new THREE.Mesh(railGeo, trimMat);
          // 0.25 + 0.22 of PANEL_H keeps the rail inside the panel's half depth
          // of 0.5; further out and the ends poked past the edge as tabs.
          rail.position.z = side * PANEL_H * 0.25;
          rail.castShadow = true;
          p.add(rail);
        }
        p.add(
          face,
          new THREE.LineSegments(cellGeo, bank.cells),
          new THREE.LineSegments(panelEdges, bank.edges),
        );
        // One gap figure for both axes. The panel is PANEL_W across the
        // slope and PANEL_H along the ridge, so the two pitches have to
        // differ by exactly that much to leave the same gap: at a single
        // shared pitch the rows sat tighter than the columns.
        const d = SLOPE_START + row * (PANEL_W + PANEL_GAP);
        const off = PANEL_LIFT + PANEL_T / 2 + 0.01;
        p.position.set(
          d * cosS + sinS * off,
          RIDGE - d * sinS + cosS * off,
          (col - 1.5) * (PANEL_H + PANEL_GAP),
        );
        panels.add(p);
      }
    }

    // ---------------- the Solarbank, and its run from the roof ----------------
    // On the same wall as the door and window, in the clear stretch to the
    // right of the window: local z from -2.5 to -1.36 carries nothing, and
    // that wall faces the camera square on. The gable end is free too, but
    // at this angle it is foreshortened to a sliver.
    const BANK_W = 0.5;
    const BANK_H = 0.95;
    const BANK_D = 0.24;
    const BANK_Z = -1.95;
    const BANK_X = WALL_FACE + BANK_D / 2;

    const bankGeo = track(new THREE.BoxGeometry(BANK_D, BANK_H, BANK_W));
    bankGeo.translate(BANK_X, PLINTH + BANK_H / 2, BANK_Z);
    house.add(shell(bankGeo, bankMat));
    const bankLedMat = track(
      new THREE.MeshBasicMaterial({ color: 0x55e89a, transparent: true, opacity: 0 }),
    );
    const bankLed = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 10, 8)), bankLedMat);
    bankLed.position.set(BANK_X + BANK_D / 2 + 0.025, PLINTH + BANK_H * 0.72, BANK_Z);
    house.add(bankLed);

    // The stack is modular, so the cabinet carries a seam between each pair
    // of modules. Built to the maximum and shown to the count: the pack
    // figure arrives with the device info, a moment after the scene is put
    // together, and rebuilding the whole scene for it would flash.
    const MAX_PACKS = 6;
    const seamGeoBank = track(new THREE.BoxGeometry(BANK_D + 0.012, 0.022, BANK_W + 0.012));
    const bankSeams: THREE.Object3D[] = [];
    for (let i = 0; i < MAX_PACKS - 1; i++) {
      const m = new THREE.Mesh(seamGeoBank, trimMat);
      m.visible = false;
      house.add(m);
      bankSeams.push(m);
    }
    const layoutSeams = (count: number) => {
      const n = Math.max(1, Math.min(count, MAX_PACKS));
      bankSeams.forEach((m, i) => {
        m.visible = i < n - 1;
        if (m.visible) m.position.set(BANK_X, PLINTH + (BANK_H * (i + 1)) / n, BANK_Z);
      });
    };
    layoutSeams(1);

    // A capping band, so it reads as a cabinet rather than a block. Straddling
    // the top rather than flush with it: sharing that face exactly is two
    // coplanar surfaces fighting for the same depth, which is the flicker
    // that was showing on the lid.
    const bankCapGeo = track(new THREE.BoxGeometry(BANK_D + 0.03, 0.07, BANK_W + 0.03));
    bankCapGeo.translate(BANK_X, PLINTH + BANK_H, BANK_Z);
    house.add(shell(bankCapGeo, trimMat));

    // Conduit from the foot of the array, out around the fascia and down the
    // wall to the top of the cabinet. Catmull-rom rather than straight
    // segments: the bends are what make it read as conduit and not a drawn
    // line, and it has to bulge past the eave because the fascia stands
    // proud of the wall it lands on.
    // Down the slope, through the roof just inboard of the fascia, then
    // straight down to the cabinet. Routing outside the fascia instead left
    // it hanging a third of a unit off the wall the whole way down.
    const conduit: Array<[number, number, number]> = [
      [1.5, 2.88, BANK_Z],
      [1.6, 2.78, BANK_Z],
      [1.6, PLINTH + BANK_H + 0.05, BANK_Z],
    ];
    const conduits: Array<{ mat: THREE.ShaderMaterial; flow: FlowKey; phase: number }> = [];

    /**
     * Points run source to destination, which is also the direction uv.x
     * increases along the tube, so the band travels the way the power does.
     */
    const runConduit = (points: Array<[number, number, number]>, flow: FlowKey, radius = 0.024) => {
      const routed = routePath(points);
      // Zero tension: the curve then passes straight between its points, so
      // the only curvature in the run is the fillet routePath put there.
      const curve = new THREE.CatmullRomCurve3(routed, false, "catmullrom", 0);
      const mat = track(
        new THREE.ShaderMaterial({
          uniforms: THREE.UniformsUtils.merge([
            THREE.UniformsLib["fog"]!,
            {
              uBase: { value: new THREE.Color(pal.trim) },
              uGlow: { value: new THREE.Color(FLOW_GLOW[flow]) },
              uPhase: { value: 0 },
              uAmount: { value: 0 },
              // From the run's real length, so a long run and a short one
              // carry the same spacing rather than the same count.
              uRepeat: { value: Math.max(1, Math.round(curve.getLength() / 0.85)) },
            },
          ]),
          vertexShader: CONDUIT_VERT,
          fragmentShader: CONDUIT_FRAG,
          fog: true,
        }),
      );
      const mesh = new THREE.Mesh(
        track(new THREE.TubeGeometry(curve, routed.length * 2, radius, 6, false)),
        mat,
      );
      mesh.castShadow = true;
      house.add(mesh);
      conduits.push({ mat, flow, phase: 0 });
    };

    runConduit(conduit, "solar");

    // ---------------- service run along the base of the walls ----------------
    // The gable end is the service wall: the panel on it, the house feed out
    // along the front. Everything below eye level runs at one height just
    // above the plinth, which is how the app draws it and how it is actually
    // done.
    const BASE_Y = 0.42;
    const GABLE_Z = -2.5;
    const GABLE_RUN = GABLE_Z - 0.055;
    const FRONT_RUN = WALL_FACE + 0.055;

    // The grid panel: a flat plate rather than a cabinet, and lighter than
    // the wall so it reads as equipment and not as a shadow.
    const METER_X = 0.75;
    const METER_Y = 1.3;
    const meterGeo = track(new THREE.BoxGeometry(0.36, 0.46, 0.075));
    meterGeo.translate(METER_X, METER_Y, GABLE_Z - 0.037);
    house.add(shell(meterGeo, frameMat));
    // A recessed face, so the plate has something on it at this distance.
    const meterFaceGeo = track(new THREE.BoxGeometry(0.22, 0.14, 0.08));
    meterFaceGeo.translate(METER_X, METER_Y + 0.08, GABLE_Z - 0.037);
    house.add(new THREE.Mesh(meterFaceGeo, bankMat));

    // Panel to the battery: down the gable, square round the corner, along
    // the front wall into the side of the cabinet.
    runConduit([
      [METER_X, METER_Y - 0.23, GABLE_RUN],
      [METER_X, BASE_Y, GABLE_RUN],
      [FRONT_RUN, BASE_Y, GABLE_RUN],
      [FRONT_RUN, BASE_Y, BANK_Z - BANK_W / 2 - 0.02],
    ], "grid");

    // Battery to the house: out of the far side of the cabinet, along the
    // front wall, up to an outlet between the window and the door.
    const SOCKET_Z = 0.2;
    const SOCKET_Y = 0.66;
    runConduit([
      [FRONT_RUN, BASE_Y, BANK_Z + BANK_W / 2 + 0.02],
      [FRONT_RUN, BASE_Y, SOCKET_Z],
      [FRONT_RUN, SOCKET_Y - 0.08, SOCKET_Z],
    ], "home");
    const socketGeo = track(new THREE.BoxGeometry(0.05, 0.16, 0.13));
    socketGeo.translate(WALL_FACE + 0.025, SOCKET_Y, SOCKET_Z);
    house.add(shell(socketGeo, frameMat));

    // Sprites belong to the house, so their anchors follow the architecture
    // through camera movement instead of being pinned to flat CSS percentages.
    const pinStyle = {
      roof: 0xc98500,
      home: 0x478abf,
      battery: 0x399c6a,
      service: 0xd56565,
      output: 0xd56565,
    } as const;
    const pinAnchors: ReadonlyArray<{ spot: keyof typeof pinStyle; position: THREE.Vector3 }> = [
      { spot: "roof", position: new THREE.Vector3(1.15, 3.58, -0.28) },
      { spot: "home", position: new THREE.Vector3(WALL_FACE + 0.15, SOCKET_Y + 0.3, SOCKET_Z) },
      { spot: "battery", position: new THREE.Vector3(BANK_X + BANK_D / 2 + 0.14, PLINTH + BANK_H + 0.28, BANK_Z) },
      { spot: "service", position: new THREE.Vector3(METER_X, METER_Y + 0.48, GABLE_Z - 0.16) },
      { spot: "output", position: new THREE.Vector3(METER_X, METER_Y - 0.25, GABLE_Z - 0.16) },
    ];
    const scenePins: Array<{
      spot: keyof typeof pinStyle;
      sprite: THREE.Sprite;
      texture: THREE.CanvasTexture;
      canvas: HTMLCanvasElement;
      anchor: THREE.Vector3;
      leader: THREE.Line;
    }> = [];
    const paintPin = (pin: (typeof scenePins)[number], value: string, light: boolean) => {
      const scale = 2;
      const font = '600 18px "Space Grotesk Variable", sans-serif';
      const unitFont = '500 12px "Space Grotesk Variable", sans-serif';
      const [number, unit = ""] = value.split(/\s+/, 2);
      const measure = pin.canvas.getContext("2d")!;
      measure.font = font;
      const numberWidth = measure.measureText(number).width;
      measure.font = unitFont;
      const unitWidth = unit ? measure.measureText(unit).width + 5 : 0;
      const width = Math.ceil(Math.max(64, numberWidth + unitWidth + 26));
      const height = 30;
      pin.canvas.width = width * scale;
      pin.canvas.height = height * scale;
      const context = pin.canvas.getContext("2d")!;
      context.scale(scale, scale);
      context.beginPath();
      context.roundRect(1, 1, width - 2, height - 2, 4);
      context.fillStyle = light ? "rgba(245, 247, 246, 0.88)" : "rgba(32, 36, 38, 0.88)";
      context.fill();
      context.lineWidth = 1;
      context.strokeStyle = light ? "rgba(35, 45, 48, 0.16)" : "rgba(225, 233, 230, 0.2)";
      context.stroke();
      context.fillStyle = `#${pinStyle[pin.spot].toString(16).padStart(6, "0")}`;
      context.fillRect(7, 10, 2, 10);
      context.font = font;
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillStyle = light ? "#293331" : "#edf3ef";
      context.fillText(number, 15, height / 2);
      context.font = unitFont;
      context.fillStyle = light ? "#626e69" : "#aab8b1";
      context.fillText(unit, 15 + numberWidth + 5, height / 2 + 2);
      pin.texture.needsUpdate = true;
      pin.sprite.scale.set(width * 0.0105, height * 0.0105, 1);
    };
    for (const anchor of pinAnchors) {
      const canvas = document.createElement("canvas");
      const texture = track(new THREE.CanvasTexture(canvas));
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      const material = track(
        new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: false }),
      );
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(anchor.position);
      sprite.renderOrder = 6;
      house.add(sprite);
      const leaderGeometry = track(new THREE.BufferGeometry().setFromPoints([anchor.position, anchor.position]));
      const leader = new THREE.Line(leaderGeometry, track(new THREE.LineBasicMaterial({
        color: 0x7b9bb1, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false,
      })));
      leader.renderOrder = 5;
      leader.visible = false;
      house.add(leader);
      const pin = { spot: anchor.spot, sprite, texture, canvas, anchor: anchor.position.clone(), leader };
      scenePins.push(pin);
      paintPin(pin, metricsRef.current.find((metric) => metric.spot === anchor.spot)?.value ?? "--", pal === LIGHT);
    }
    let pinSignature = "";

    // ---------------- ground ----------------
    // One world unit per cell, so the plinth lands exactly on cell
    // boundaries. The fade is centred on the house and dissolves the plot
    // into the page, so the ground has no visible border to give it away.
    const gridGeo = track(groundGrid(46, 1, 3, -1, 10, 21));
    const gridMat = track(
      new THREE.LineBasicMaterial({
        color: pal.grid,
        transparent: true,
        opacity: 0.62,
        vertexColors: true,
        // Left out of the filmic curve: these are drafting lines, not light,
        // and ACES crushes them to nothing on the dark ground.
        toneMapped: false,
        fog: true,
      }),
    );
    const grid = new THREE.LineSegments(gridGeo, gridMat);
    grid.renderOrder = 0;
    scene.add(grid);

    // Catches the key light's shadow. Transparent everywhere else, so the
    // grid still shows through.
    const shadowMat = track(new THREE.ShadowMaterial({ opacity: pal.shadow }));
    const shadowPlane = new THREE.Mesh(track(new THREE.PlaneGeometry(46, 46)), shadowMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = 0.004;
    shadowPlane.receiveShadow = true;
    shadowPlane.renderOrder = 1;
    scene.add(shadowPlane);

    const contactTex = track(contactTexture());
    const contactMat = track(
      new THREE.MeshBasicMaterial({
        map: contactTex,
        transparent: true,
        depthWrite: false,
        opacity: pal.contact,
        color: 0x000000,
        fog: true,
      }),
    );
    const contactGeo = track(new THREE.PlaneGeometry(1, 1));
    const contacts = new THREE.Group();
    scene.add(contacts);

    /** Grounds one object with a soft blob the size of its footprint. */
    const addContact = (x: number, z: number, radius: number) => {
      const m = new THREE.Mesh(contactGeo, contactMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.008, z);
      m.scale.setScalar(radius * 2);
      m.renderOrder = 2;
      contacts.add(m);
    };

    // Under the house too - but tight. The shadow map already gives it a
    // cast shadow; this is only the dark seam where the plinth meets the
    // ground, and at any width it reads as a disc drawn on the lawn.
    addContact(4.0, -1.0, 3.2);
    addContact(0.0, -1.0, 2.8);

    // ---------------- trees and bushes to the left ----------------
    const flora = new THREE.Group();
    scene.add(flora);

    const coneGeo = track(new THREE.ConeGeometry(1, 1, 14));
    const trunkGeo = track(new THREE.CylinderGeometry(0.07, 0.13, 1, 10));
    // Subdivided twice for the canopies: at one subdivision the facets are
    // large enough that a crown reads as a die rather than as foliage.
    const bushGeo = track(new THREE.IcosahedronGeometry(1, 2));
    // Kept coarse for the undergrowth, where the facets are the point.
    const lobeGeo = track(new THREE.IcosahedronGeometry(1, 1));

    let plantSeed = 7321;
    const plantRandom = () => THREE.MathUtils.seededRandom(plantSeed++);
    const leafMat = () => foliageMats[Math.floor(plantRandom() * foliageMats.length)]!;

    /**
     * `bare` drops the lowest ring and stands the crown on a longer trunk.
     *
     * With every ring present the widest one skirts the ground and, from a
     * camera looking down at the scene, hides the trunk completely - so a
     * stand of them reads as a row of cones with nothing holding them up.
     * Only some, so the treeline keeps two silhouettes rather than one.
     */
    /**
     * Trees are grown once and then planted many times.
     *
     * A branch system is far more geometry than a stack of cones, so building
     * one per tree would cost thirty generations and thirty pairs of buffers.
     * A handful of archetypes cloned around the plot gives the same variety
     * on screen - clones share geometry and material - for a fixed cost.
     */
    const archetype = (grow: (random: () => number) => { limbs: Limb[]; tips: Tip[] }, radial: number, squash: number, random = plantRandom) => {
      const growthSeed = plantSeed;
      const { limbs, tips } = grow(random);
      const bark = new THREE.Mesh(track(limbGeometry(limbs, radial)), trunkMat);
      const leaves = new THREE.Mesh(track(foliageGeometry(tips, squash, random)), foliageMats[Math.floor(random() * foliageMats.length)]!);
      bark.castShadow = true;
      leaves.castShadow = true;
      const g = new THREE.Group();
      g.userData.growthSeed = growthSeed;
      g.userData.foliageTips = tips;
      g.userData.foliageSquash = squash;
      g.add(bark, leaves);
      return g;
    };

    const firStock = Array.from({ length: 4 }, () => archetype(growFir, 5, 0.46));
    const broadleafStock = Array.from({ length: 4 }, () => archetype(growBroadleaf, 5, 0.92));
    const bushStock = Array.from({ length: 4 }, () => archetype(growBush, 4, 0.86));

    const standTree = (stock: THREE.Group[], x: number, z: number, scale: number, contact: number, extraBranches = false) => {
      const source = stock[Math.floor(plantRandom() * stock.length)]!;
      let branchSeed = source.userData.growthSeed as number;
      const t = extraBranches
        ? archetype((random) => growBroadleaf(random, 3), 5, 0.92, () => THREE.MathUtils.seededRandom(branchSeed++))
        : source.clone();
      let leafSeed = source.userData.growthSeed as number;
      const foliageSource = extraBranches ? t : source;
      (t.children[1] as THREE.Mesh).geometry = track(foliageGeometry(
        foliageSource.userData.foliageTips as Tip[],
        foliageSource.userData.foliageSquash as number,
        () => THREE.MathUtils.seededRandom(leafSeed++),
        scale,
      ));
      if (extraBranches) (t.children[1] as THREE.Mesh).material = (source.children[1] as THREE.Mesh).material;
      t.position.set(x, 0, z);
      t.scale.setScalar(scale);
      t.rotation.y = plantRandom() * Math.PI * 2;
      flora.add(t);
      addContact(x, z, scale * contact * 0.3);
    };

    // The generators size their own trunks, so the caller's scale is a nudge
    // rather than the whole height.
    const addFir = (x: number, z: number, scale: number) => standTree(firStock, x, z, scale * 0.92, 0.9);
    const addBroadleaf = (x: number, z: number, scale: number, extraBranches = false) =>
      standTree(broadleafStock, x, z, scale * 1.15, 1.1, extraBranches);

    const addBush = (x: number, z: number, scale: number) =>
      standTree(bushStock, x, z, scale * 1.7, 1.3);

    // A planter by the door. Local +z is screen left and x past the wall
    // face puts it out on the slab, in front of the elevation. It lives here
    // rather than with the house because it needs the bush geometry and the
    // foliage tones, which the planting section owns.
    {
      const potX = 2.0;
      const potZ = 1.8;

      const potGeo = track(new THREE.CylinderGeometry(0.22, 0.16, 0.34, 12));
      potGeo.translate(potX, PLINTH + 0.17, potZ);
      house.add(solidMesh(potGeo, roofMat));

      const rimGeo = track(new THREE.CylinderGeometry(0.245, 0.245, 0.06, 12));
      rimGeo.translate(potX, PLINTH + 0.32, potZ);
      house.add(solidMesh(rimGeo, roofMat));

      // The same shrub the ground planting uses, sized to the pot. A cluster
      // of loose lobes was the last thing here still built from primitives.
      const potted = bushStock[Math.floor(plantRandom() * bushStock.length)]!.clone();
      potted.position.set(potX, PLINTH + 0.32, potZ);
      // Taller than wide, the way a potted shrub is trained.
      potted.scale.set(0.46, 0.62, 0.46);
      potted.rotation.y = plantRandom() * Math.PI * 2;
      house.add(potted);
    }

    // Six specimens frame rather than surround the house. The largest rear
    // tree is deliberately off-centre, with companion shrubs tying each
    // specimen into the ground while the right foreground stays open.
    addFir(-9.3, -7.8, 1.08);
    addBroadleaf(-3.8, -10.2, 1.42);
    addBroadleaf(2.35, -10.0, 1.82, true);
    addBroadleaf(5.7, -8.9, 1.18);
    addBroadleaf(-13.5, 2.15, 0.96);
    addFir(-7.2, 4.65, 0.78);

    addBush(-10.2, -6.95, 0.26);
    addBush(-8.35, -8.65, 0.56);
    addBush(-5.25, -9.25, 0.58);
    addBush(-2.65, -11.05, 0.27);
    addBush(-2.05, -9.9, 0.62);
    addBush(0.95, -11.45, 0.3);
    addBush(4.65, -8.05, 0.52);
    addBush(6.95, -9.7, 0.22);
    addBush(-3.6, 0.05, 1.18);
    addBush(-14.45, 1.1, 0.48);
    addBush(-12.4, 3.1, 0.23);
    addBush(-8.15, 4.0, 0.42);
    addBush(-6.4, 5.45, 0.2);

    house.updateMatrixWorld(true);
    flora.updateMatrixWorld(true);
    const plantingBounds = new THREE.Box3().setFromObject(flora);
    const shadowBounds = new THREE.Box3().setFromObject(house).union(plantingBounds);
    shadowBounds.min.y = 0;
    const shadowLightPosition = key.position.clone();
    const fitShadowCamera = () => {
      shadowLightPosition.copy(key.position);
      sc.position.copy(key.position);
      sc.lookAt(key.target.position);
      sc.updateMatrixWorld(true);
      const lightBounds = shadowBounds.clone().applyMatrix4(sc.matrixWorldInverse);
      sc.left = lightBounds.min.x - 2;
      sc.right = lightBounds.max.x + 2;
      sc.bottom = lightBounds.min.y - 2;
      sc.top = lightBounds.max.y + 2;
      sc.near = Math.max(0.1, -lightBounds.max.z - 2);
      sc.far = Math.max(sc.near + 1, -lightBounds.min.z + 10);
      sc.updateProjectionMatrix();
      renderer.shadowMap.needsUpdate = true;
    };
    fitShadowCamera();

    // ---------------- clouds ----------------
    const clouds = new THREE.Group();
    scene.add(clouds);
    // Bounded density fields preserve the depth and self-occlusion cues of
    // volumetric clouds without turning the entire header into a raymarch.
    const cloudVolumes: Array<{ mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> }> = [];
    const viewForward = LOOK.clone().sub(camera.position).normalize();
    const viewRight = new THREE.Vector3().crossVectors(viewForward, new THREE.Vector3(0, 1, 0)).normalize();
    /**
     * Clouds are grown, not listed.
     *
     * Four hand-written layouts meant four silhouettes in the sky, and the eye
     * spots a repeat immediately. Each cloud now picks its own lobe count,
     * spine, taper and shading, and every lobe gets its own squash and cut, so
     * no two are the same shape at any size.
     */
    const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
    const cloudLayouts = Array.from({ length: 6 }, (_, i) => {
      const lobeCount = 3 + Math.floor(Math.random() * 4);
      // The spine sags or arches a little, and the ends taper off.
      const arch = rand(-0.22, 0.42);
      const lobes = Array.from({ length: lobeCount }, (_, k) => {
        const t = lobeCount === 1 ? 0.5 : k / (lobeCount - 1);
        const centred = 1 - Math.abs(t - 0.5) * 2;
        return [
          (t - 0.5) * lobeCount * rand(0.72, 0.98),
          arch * centred + rand(-0.12, 0.12),
          rand(-0.24, 0.24),
          (0.42 + centred * 0.62) * rand(0.82, 1.2),
          (0.4 + centred * 0.72) * rand(0.78, 1.28),
        ] as const;
      });
      return {
        // Spread across the band with jitter, so they are neither evenly
        // spaced nor bunched.
        offset: -14 + i * 5.6 + rand(-1.8, 1.8),
        height: rand(3.1, 5.4),
        scale: rand(0.42, 1.28),
        shade: rand(0.74, 1.1),
        lobes,
      };
    });

    for (const { offset, height, scale, shade, lobes } of cloudLayouts) {
      const centre = LOOK.clone().addScaledVector(viewForward, 18).addScaledVector(viewRight, offset);
      const drift = 0.05 + Math.random() * 0.13;
      for (const [lobeX, lobeY, lobeZ, lobeWidth, lobeHeight] of lobes) {
        const bounds = new THREE.Vector3(2.45 * scale * lobeWidth, 1.4 * scale * lobeHeight, 1.3 * scale * lobeWidth);
        const uniforms: Record<string, THREE.IUniform> = {
          uTop: { value: new THREE.Color(pal.cloud) },
          uLow: { value: new THREE.Color(pal.cloudLow) },
          uShade: { value: shade },
          uSquash: { value: new THREE.Vector3(rand(0.52, 0.84), rand(1.05, 1.5), rand(0.82, 1.15)) },
          uCut: { value: new THREE.Vector2(rand(0.14, 0.3), rand(0.5, 0.68)) },
          uOctaves: { value: new THREE.Vector3(rand(0.44, 0.66), rand(0.22, 0.38), rand(0.08, 0.2)) },
          uOpacity: { value: 0.5 },
          uTime: { value: 0 },
          uSeed: { value: Math.random() * 20 },
          uCamera: { value: new THREE.Vector3() },
          uBounds: { value: bounds },
        };
        const material = track(
          new THREE.ShaderMaterial({
            uniforms,
            vertexShader: CLOUD_VERT,
            fragmentShader: CLOUD_FRAG,
            transparent: true,
            depthWrite: false,
            side: THREE.BackSide,
          }),
        );
        const mesh = new THREE.Mesh(track(new THREE.BoxGeometry(bounds.x * 2, bounds.y * 2, bounds.z * 2)), material);
        mesh.position.copy(centre).addScaledVector(viewRight, lobeX * scale).addScaledVector(viewForward, lobeZ * scale);
        mesh.position.y = height + lobeY * scale;
        mesh.userData["drift"] = drift;
        clouds.add(mesh);
        cloudVolumes.push({ mesh, uniforms });
      }
    }

    // ---------------- sky: rays and rain ----------------

    // Shafts are aimed: they spawn in the column of sky that drifts down onto
    // the roof, so the light lands on the panels instead of raining on the
    // whole plot. The x offset accounts for the slant travelled on the way.
    const RAY_TOP = 13.5;
    panels.updateWorldMatrix(true, true);

    const makeRays = (count: number) => {
      // Four vertices per shaft: head and tail, each side of the width.
      const verts = count * 4;
      const pos = new Float32Array(verts * 3);
      const rates = new Float32Array(verts);
      const lens = new Float32Array(verts);
      const seeds = new Float32Array(verts);
      const ends = new Float32Array(verts);
      const sides = new Float32Array(verts);
      const widths = new Float32Array(verts);
      const beams = new Float32Array(verts);
      const spans = new Float32Array(verts);
      const index = new Uint16Array(count * 6);

      for (let i = 0; i < count; i++) {
        const beam = i < 3;
        const panel = panels.children[beam ? i * 3 : i % panels.children.length]!;
        const across = beam ? 0 : (Math.random() - 0.5) * PANEL_W * 0.8;
        const along = beam ? 0 : (Math.random() - 0.5) * PANEL_H * 0.8;
        const surfaceOffset = PANEL_T / 2 + 0.015;
        const target = panel.localToWorld(new THREE.Vector3(
          across * cosS + sinS * surfaceOffset,
          -across * sinS + cosS * surfaceOffset,
          along,
        ));
        if (beam) sunHits.value[i]!.copy(target);
        const span = RAY_TOP - target.y;
        const x = target.x - Math.tan(RAY_SLANT) * span;
        const y = RAY_TOP - Math.random() * span;
        const z = target.z;
        const rate = beam ? 0.2 + i * 0.3 : Math.random();
        const seed = beam ? 0 : Math.random();
        // Strongly varied: short dashes through to long streaks.
        const len = beam ? 6.5 + i * 0.65 : 0.4 + Math.pow(Math.random(), 1.7) * 2.8;
        // Longer shafts are wider, so they read as beams rather than threads.
        const width = beam ? 0.38 + i * 0.12 : 0.012 + Math.pow(Math.random(), 1.5) * 0.05 + len * 0.008;

        for (let c = 0; c < 4; c++) {
          const v = i * 4 + c;
          pos[v * 3] = x;
          pos[v * 3 + 1] = y;
          pos[v * 3 + 2] = z;
          rates[v] = rate;
          lens[v] = len;
          seeds[v] = seed;
          // Corners: (head,-) (head,+) (tail,+) (tail,-)
          ends[v] = c === 0 || c === 1 ? 0 : 1;
          sides[v] = c === 0 || c === 3 ? -1 : 1;
          widths[v] = width;
          beams[v] = beam ? 1 : 0;
          spans[v] = span;
        }

        const b = i * 4;
        index.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
      }

      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("aRate", new THREE.BufferAttribute(rates, 1));
      geo.setAttribute("aLen", new THREE.BufferAttribute(lens, 1));
      geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
      geo.setAttribute("aEnd", new THREE.BufferAttribute(ends, 1));
      geo.setAttribute("aSide", new THREE.BufferAttribute(sides, 1));
      geo.setAttribute("aWidth", new THREE.BufferAttribute(widths, 1));
      geo.setAttribute("aBeam", new THREE.BufferAttribute(beams, 1));
      geo.setAttribute("aSpan", new THREE.BufferAttribute(spans, 1));
      geo.setIndex(new THREE.BufferAttribute(index, 1));

      const uniforms = {
        uPhase: { value: 0 },
        uColor: { value: new THREE.Color("#ffd08a") },
        uOpacity: { value: 0 },
        uAmount: { value: 1 },
        uSlant: { value: Math.tan(RAY_SLANT) },
        uTop: { value: RAY_TOP },
      };
      const mat = track(
        new THREE.ShaderMaterial({
          uniforms,
          vertexShader: RAY_VERT,
          fragmentShader: RAY_FRAG,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        }),
      );
      return { points: new THREE.Mesh(geo, mat), uniforms };
    };

    const makeRain = (count: number) => {
      const pos = new Float32Array(count * 3);
      const rates = new Float32Array(count);
      const lens = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 30 + 2;
        pos[i * 3 + 1] = Math.random() * 22 - 9;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 14 - 1;
        rates[i] = Math.random();
        lens[i] = 0.14 + Math.random() * 0.12;
      }
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("aRate", new THREE.BufferAttribute(rates, 1));
      geo.setAttribute("aLen", new THREE.BufferAttribute(lens, 1));

      const uniforms = {
        uPhase: { value: 0 },
        uColor: { value: new THREE.Color("#7fa8d8") },
        uOpacity: { value: 0 },
      };
      const mat = track(
        new THREE.ShaderMaterial({
          uniforms,
          vertexShader: RAIN_VERT,
          fragmentShader: RAIN_FRAG,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          blending: THREE.AdditiveBlending,
        }),
      );
      return { points: new THREE.Points(geo, mat), uniforms };
    };

    const rays = makeRays(RAY_COUNT);
    rays.points.renderOrder = 4;
    scene.add(rays.points);

    const flareCanvas = document.createElement("canvas");
    flareCanvas.width = flareCanvas.height = 128;
    const flareContext = flareCanvas.getContext("2d")!;
    const flareGradient = flareContext.createRadialGradient(64, 64, 0, 64, 64, 62);
    flareGradient.addColorStop(0, "rgba(255,250,230,1)");
    flareGradient.addColorStop(0.08, "rgba(255,244,215,0.85)");
    flareGradient.addColorStop(0.3, "rgba(255,237,195,0.12)");
    flareGradient.addColorStop(1, "rgba(255,237,195,0)");
    flareContext.fillStyle = flareGradient;
    flareContext.fillRect(0, 0, 128, 128);
    for (const rotation of [0, Math.PI / 2]) {
      flareContext.save();
      flareContext.translate(64, 64);
      flareContext.rotate(rotation);
      flareContext.scale(1, 0.055);
      flareContext.translate(-64, -64);
      flareContext.fillRect(0, 0, 128, 128);
      flareContext.restore();
    }
    const flareTexture = track(new THREE.CanvasTexture(flareCanvas));
    const panelNormal = new THREE.Vector3(sinS, cosS, 0).transformDirection(house.matrixWorld);
    const reflectedSun = sunDirection.clone().negate().reflect(panelNormal);
    const flareView = new THREE.Vector3();
    const sunFlares = sunHits.value.map((hit) => {
      const material = track(new THREE.SpriteMaterial({
        map: flareTexture, transparent: true, opacity: 0,
        depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
        toneMapped: false, rotation: Math.PI / 4,
      }));
      const flare = new THREE.Sprite(material);
      flare.position.copy(hit).addScaledVector(panelNormal, 0.045);
      flare.scale.setScalar(0.65);
      scene.add(flare);
      return flare;
    });

    const rain = makeRain(320);
    rain.points.renderOrder = 4;
    scene.add(rain.points);

    // ---------------- theme ----------------
    const applyPalette = (p: Palette) => {
      environment = p === LIGHT ? ENVIRONMENTS.light : ENVIRONMENTS.dark;
      plinthMat.color.setHex(p.plinth);
      doorMat.color.setHex(p.door);
      trimMat.color.setHex(p.trim);
      frameMat.color.setHex(p.frame);
      glassMat.color.setHex(p.glass);
      bankMat.color.setHex(p.bank);
      wallMat.color.setHex(p.wall);
      roofMat.color.setHex(p.roof);
      trunkMat.color.setHex(p.trunk);
      foliageMats.forEach((m, i) => m.color.setHex(p.foliage[i % p.foliage.length]!));
      gridMat.color.setHex(p.grid);
      for (const cloud of cloudVolumes) {
        (cloud.uniforms.uTop!.value as THREE.Color).setHex(p.cloud);
        (cloud.uniforms.uLow!.value as THREE.Color).setHex(p.cloudLow);
      }
      fog.color.setHex(p.fog);
      hemi.color.setHex(p.hemiSky);
      hemi.groundColor.setHex(p.hemiGround);
      hemi.intensity = p.hemiIntensity;
      key.color.setHex(p.keyColor);
      key.intensity = p.keyIntensity;
      fill.intensity = p.fillIntensity;
      for (const c of conduits) (c.mat.uniforms["uBase"]!.value as THREE.Color).setHex(p.trim);
      glossUniform.value = p.gloss;
      shadowMat.opacity = p.shadow;
      contactMat.opacity = p.contact;
    };
    applyPalette(pal);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    // A shallow lean that follows the pointer. Small on purpose: enough to
    // give the scene some parallax against a flat page, not enough to leave
    // the composition the framing was chosen for.
    const TILT_YAW = 0.075;
    const TILT_PITCH = 0.05;
    let wantX = 0;
    let wantY = 0;
    let tiltX = 0;
    let tiltY = 0;
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || host.clientWidth <= 700) return;
      wantX = (e.clientX / window.innerWidth - 0.5) * 2;
      wantY = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    if (!reduced.matches) window.addEventListener("pointermove", onPointer, { passive: true });

    const resize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / host.clientHeight;
      const mobile = host.clientWidth <= 700;
      viewTarget.copy(mobile ? mobileLook : LOOK);
      camera.zoom = mobile ? 1.35 : 1;
      // Extra canvas depth lets the grid flow behind the dashboard. Increase
      // vertical FOV by the same ratio so the original horizontal framing of
      // the house and tree line remains intact.
      camera.fov =
        mobile
          ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(46) / 2) / camera.aspect))
          : host.clientHeight > BASE_SCENE_HEIGHT
          ? THREE.MathUtils.radToDeg(
              2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2) * (host.clientHeight / BASE_SCENE_HEIGHT)),
            )
          : BASE_FOV;
      camera.updateProjectionMatrix();
      if (mobile) wantX = wantY = tiltX = tiltY = 0;
      aimCamera(BASE_YAW + tiltX * TILT_YAW, BASE_PITCH + tiltY * TILT_PITCH);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    // Timer, not the deprecated Clock. Connecting it to the document lets it
    // use the Page Visibility API, so a backgrounded tab does not report the
    // whole time away as one delta.
    const timer = new THREE.Timer();
    timer.connect(document);
    let frame = 0;
    // Eased speeds live here; the shaders only ever see accumulated phase.
    let raySpeed = 0.4;
    let rayPhase = 0;
    let lastPacks = 1;
    let rainPhase = 0;
    let shadowDusk = -1;

    const render = (dt: number) => {
      const target = targetRef.current;

      const nextPal = document.documentElement.dataset["theme"] === "light" ? LIGHT : DARK;
      if (nextPal !== pal) {
        pal = nextPal;
        applyPalette(pal);
      }

      const nextPinSignature = `${pal === LIGHT}|${metricsRef.current.map((metric) => metric.value).join("|")}`;
      if (nextPinSignature !== pinSignature) {
        pinSignature = nextPinSignature;
        for (const pin of scenePins) {
          const metric = metricsRef.current.find((item) => item.spot === pin.spot);
          paintPin(pin, metric?.value ?? "--", pal === LIGHT);
        }
      }

      const duskAmount = target.day * target.dusk;
      const nightAmount = 1 - target.day;
      const blendEnvironment = (out: THREE.Color, colors: readonly [THREE.Color, THREE.Color, THREE.Color]) => {
        out.copy(colors[0]).lerp(colors[1], duskAmount).lerp(colors[2], nightAmount);
      };
      blendEnvironment(skyColor, environment.sky);
      blendEnvironment(fog.color, environment.fog);
      blendEnvironment(gridMat.color, environment.ground);
      for (const cloud of cloudVolumes) {
        blendEnvironment(cloud.uniforms.uTop!.value as THREE.Color, environment.cloud);
        blendEnvironment(cloud.uniforms.uLow!.value as THREE.Color, environment.cloudLow);
      }

      const keyPosition = dayKeyPosition.clone().lerp(duskKeyPosition, target.dusk);
      key.position.lerp(keyPosition, 0.025);
      key.color.copy(new THREE.Color(pal.keyColor)).lerp(duskKeyColor, duskAmount);
      if (pal === LIGHT) key.color.lerp(LIGHT_NIGHT_KEY, nightAmount);
      else key.color.lerp(DARK_NIGHT_KEY, nightAmount);
      if (pal === LIGHT) {
        hemi.color.copy(new THREE.Color(pal.hemiSky)).lerp(LIGHT_NIGHT_HEMI_SKY, nightAmount);
        hemi.groundColor.copy(new THREE.Color(pal.hemiGround)).lerp(LIGHT_NIGHT_HEMI_GROUND, nightAmount);
      } else {
        hemi.color.copy(new THREE.Color(pal.hemiSky)).lerp(DARK_NIGHT_HEMI_SKY, nightAmount);
        hemi.groundColor.copy(new THREE.Color(pal.hemiGround)).lerp(DARK_NIGHT_HEMI_GROUND, nightAmount);
        wallMat.color.copy(new THREE.Color(pal.wall)).lerp(DARK_NIGHT_WALL, nightAmount);
        roofMat.color.copy(new THREE.Color(pal.roof)).lerp(DARK_NIGHT_ROOF, nightAmount);
        trimMat.color.copy(new THREE.Color(pal.trim)).lerp(DARK_NIGHT_TRIM, nightAmount);
        frameMat.color.copy(new THREE.Color(pal.frame)).lerp(DARK_NIGHT_FRAME, nightAmount);
        plinthMat.color.copy(new THREE.Color(pal.plinth)).lerp(DARK_NIGHT_PLINTH, nightAmount);
      }
      const nightLightLevel = pal === LIGHT ? 0.32 : 0.48;
      fill.color.copy(dayFillColor).lerp(nightFillColor, pal === DARK ? nightAmount : 0);
      const nightHemiLevel = pal === LIGHT ? 0.42 : 0.68;
      key.intensity += (pal.keyIntensity * (target.day ? 1 - target.dusk * 0.35 : nightLightLevel) - key.intensity) * 0.025;
      const dayHemiLevel = pal === LIGHT ? 0.82 : pal.hemiIntensity;
      const dayFillLevel = pal === LIGHT ? 0.56 : pal.fillIntensity;
      hemi.intensity += ((target.day ? dayHemiLevel * (1 - target.dusk * 0.16) : pal.hemiIntensity * nightHemiLevel) - hemi.intensity) * 0.025;
      fill.intensity += ((target.day ? dayFillLevel : pal.fillIntensity * 0.45) - fill.intensity) * 0.025;
      wallMat.emissive.setHex(pal === LIGHT ? 0xffffff : 0x000000);
      const wallLift = pal === LIGHT && target.day ? 0.055 * (1 - target.dusk * 0.3) : 0;
      wallMat.emissiveIntensity += (wallLift - wallMat.emissiveIntensity) * 0.035;
      glassMat.emissive.setHex(pal === LIGHT ? 0xffe2b8 : 0xffc47a);
      const windowGlow = pal === LIGHT ? 0.38 : 0.5;
      glassMat.emissiveIntensity += ((1 - target.day) * windowGlow - glassMat.emissiveIntensity) * 0.035;
      bankLedMat.opacity += ((1 - target.day) * 0.72 - bankLedMat.opacity) * 0.05;
      if (Math.abs(target.dusk - shadowDusk) > 0.05 || key.position.distanceToSquared(shadowLightPosition) > 0.0025) {
        shadowDusk = target.dusk;
        fitShadowCamera();
      }

      rays.uniforms.uColor.value.lerp(new THREE.Color("#ffd08a"), 0.03);

      const solar = target.solar;
      // The array brightens with what it is making. Cool, and gently: the
      // cell lines do most of the work, so the glass never leaves its hue.
      panelBanks.forEach((bank, index) => {
        const stringPower = target.strings[index] ?? solar;
        bank.face.emissiveIntensity += (stringPower * 0.3 - bank.face.emissiveIntensity) * 0.04;
        bank.cells.opacity += (0.18 + stringPower * 0.55 - bank.cells.opacity) * 0.04;
        bank.edges.opacity += (0.35 + stringPower * 0.45 - bank.edges.opacity) * 0.04;
      });

      const directSun = target.day * (1 - target.cloud) * (1 - target.dusk * 0.85);
      glintClock.value += dt;
      glintLife.value.forEach((_, index) => {
        const cycle = glintClock.value / 8.5 + index * 0.37;
        const slot = Math.floor(cycle);
        const age = (cycle - slot) * 8.5;
        const seed = Math.sin(slot * 45.164 + index * 78.233) * 43758.5453;
        const active = seed - Math.floor(seed) > 0.35;
        glintLife.value[index] = active
          ? 0.55 * THREE.MathUtils.smoothstep(age, 0, 0.22) * (1 - THREE.MathUtils.smoothstep(age, 0.35, 1.15))
          : 0;
      });
      glintUniform.value +=
        (directSun * 1.5 - glintUniform.value) * 0.03;

      // A light suggestion of direct sun, not a weather effect. The warmer
      // key light owns golden hour; these thin out before it takes over.
      const rayTarget = directSun * 0.17;
      rays.uniforms.uOpacity.value += (rayTarget - rays.uniforms.uOpacity.value) * 0.03;
      // Fraction of shafts drawn, straight from PV output.
      rays.uniforms.uAmount.value += (Math.min(0.13 + solar * 0.38, 0.48) - rays.uniforms.uAmount.value) * 0.03;
      // Sunnier means the shafts sweep through faster.
      raySpeed += (0.2 + solar * 0.8 - raySpeed) * 0.04;

      rain.uniforms.uOpacity.value += (target.rain * 0.55 - rain.uniforms.uOpacity.value) * 0.03;

      for (const cloud of cloudVolumes) {
        const nightContrast = pal === LIGHT && !target.day ? 1.35 : 1;
        cloud.uniforms.uOpacity!.value += ((0.42 + target.cloud * 0.58) * nightContrast - cloud.uniforms.uOpacity!.value) * 0.03;
        cloud.uniforms.uTime!.value += dt;
        (cloud.uniforms.uCamera!.value as THREE.Vector3).copy(camera.position).sub(cloud.mesh.position);
      }
      for (const c of clouds.children) {
        c.position.x += (c.userData["drift"] as number) * dt;
        if (c.position.x > 24) c.position.x = -24;
      }

      // Each run carries its own phase: they run at different speeds, and a
      // shared clock would make a quiet cable pulse as fast as a busy one.
      for (const c of conduits) {
        const amount = c.mat.uniforms["uAmount"]!;
        amount.value += (target.flow[c.flow] - amount.value) * 0.05;
        c.phase += dt * (0.25 + amount.value * 0.85) * target.direction[c.flow];
        c.mat.uniforms["uPhase"]!.value = c.phase;
      }

      if (lastPacks !== target.packs) {
        lastPacks = target.packs;
        layoutSeams(lastPacks);
      }

      // Fixed, grid-aligned: any sway left it sitting askew on the plinth.
      // The lean lives in the camera instead, so the house never tips.
      house.rotation.y = -Math.PI / 2;

      tiltX += (wantX - tiltX) * 0.045;
      tiltY += (wantY - tiltY) * 0.045;
      aimCamera(BASE_YAW + tiltX * TILT_YAW, BASE_PITCH - tiltY * TILT_PITCH);

      camera.updateMatrixWorld();
      house.updateMatrixWorld();
      sunFlares.forEach((flare, index) => {
        flareView.copy(camera.position).sub(sunHits.value[index]!).normalize();
        const viewStrength = Math.pow(Math.max(0, flareView.dot(reflectedSun)), 12);
        flare.material.opacity = glintUniform.value * glintLife.value[index]! * (0.06 + viewStrength) * 0.85;
      });
      for (const pin of scenePins) {
        let pinScale = 0.0105;
        pin.sprite.position.copy(pin.anchor);
        pin.leader.visible = host.clientWidth <= 700 && pin.spot !== "roof";
        if (host.clientWidth <= 700) {
          const viewPosition = pin.sprite.getWorldPosition(new THREE.Vector3()).applyMatrix4(camera.matrixWorldInverse);
          const unitsPerPixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * -viewPosition.z) / (host.clientHeight * camera.zoom);
          pinScale = Math.max(pinScale, unitsPerPixel * 22 / 30);
          const offsets = { roof: [0, 0], home: [-22, 0], battery: [-5, 32], service: [22, -18], output: [24, 14] } as const;
          const [offsetX, offsetY] = offsets[pin.spot];
          const projected = pin.sprite.getWorldPosition(new THREE.Vector3()).project(camera);
          projected.x += offsetX * 2 / host.clientWidth;
          projected.y -= offsetY * 2 / host.clientHeight;
          pin.sprite.position.copy(house.worldToLocal(projected.unproject(camera)));
          const points = pin.leader.geometry.getAttribute("position");
          points.setXYZ(1, pin.sprite.position.x, pin.sprite.position.y, pin.sprite.position.z);
          points.needsUpdate = true;
          pin.leader.geometry.computeBoundingSphere();
        }
        pin.sprite.scale.set(pin.canvas.width / 2 * pinScale, pin.canvas.height / 2 * pinScale, 1);
      }
      renderer.render(scene, camera);
      if (!sceneRevealed) {
        sceneRevealed = true;
        renderer.domElement.dataset.ready = "true";
      }
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) return;
      timer.update();
      // Belt and braces on top of the visibility handling: a visible but
      // stalled tab can still hand back a delta big enough to leap the
      // phases a hundred cycles.
      const dt = Math.min(timer.getDelta(), 0.1);
      rayPhase += dt * raySpeed;
      rainPhase += dt * 3.2;
      rays.uniforms.uPhase.value = rayPhase;
      rain.uniforms.uPhase.value = rainPhase;
      render(dt);
    };

    resize();
    if (reduced.matches) render(0);
    else tick();

    return () => {
      cancelAnimationFrame(frame);
      timer.dispose();
      window.removeEventListener("pointermove", onPointer);
      observer.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <section
      className="house"
      ref={hostRef}
      aria-label={`Live power: ${metrics.map((metric) => `${metric.label} ${metric.value}`).join(", ")}`}
    />
  );
}
