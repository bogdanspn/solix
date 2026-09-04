import { useEffect, useRef } from "react";
import * as THREE from "three";
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
  /** Household draw, for the run from the cabinet to the outlet. */
  homeW: number;
  /** Mains coming in, for the run from the grid panel. */
  mainsW: number;
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
  door: 0x27303d,
  plinth: 0x3d4856,
  wall: 0x728298,
  roof: 0x415170,
  // Only a little under the roof: as a strong contrast the bands read as
  // gaps in the roof rather than as edges of it.
  trim: 0x3b4a66,
  frame: 0x718093,
  glass: 0x5b7ea8,
  bank: 0x22272f,
  grid: 0x3c4450,
  foliage: [0x24503a, 0x1c4030, 0x2b5c42],
  trunk: 0x3a2f27,
  cloud: 0x2a2f38,
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

type Environment = Record<"sky" | "fog" | "ground" | "cloud", readonly [THREE.Color, THREE.Color, THREE.Color]>;

const ENVIRONMENTS: Record<"dark" | "light", Environment> = {
  dark: {
    sky: [new THREE.Color(0x0c0d0f), new THREE.Color(0x241a20), new THREE.Color(0x040711)],
    fog: [new THREE.Color(0x0c0d0f), new THREE.Color(0x181217), new THREE.Color(0x060914)],
    ground: [new THREE.Color(0x3c4450), new THREE.Color(0x5b4a4b), new THREE.Color(0x293447)],
    cloud: [new THREE.Color(0x526076), new THREE.Color(0x7a626b), new THREE.Color(0x7d90ac)],
  },
  light: {
    sky: [new THREE.Color(0xeceef1), new THREE.Color(0xe5c9bd), new THREE.Color(0x9da0a5)],
    fog: [new THREE.Color(0xeceef1), new THREE.Color(0xd8b8aa), new THREE.Color(0xaeb1b5)],
    ground: [new THREE.Color(0xc2c9d4), new THREE.Color(0xd1aea1), new THREE.Color(0xb4b7bb)],
    cloud: [new THREE.Color(0xaeb9c8), new THREE.Color(0xd9b6ad), new THREE.Color(0x66717d)],
  },
};

const LIGHT_NIGHT_KEY = new THREE.Color(0xdce4ed);
const LIGHT_NIGHT_HEMI_SKY = new THREE.Color(0xd7dfe9);
const LIGHT_NIGHT_HEMI_GROUND = new THREE.Color(0x939aa3);
const DARK_NIGHT_KEY = new THREE.Color(0x9cb2d0);

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
   */
  uniform float uPhase;
  uniform float uAmount;
  uniform float uSlant;
  uniform float uTop;
  uniform float uSpan;
  attribute float aRate;
  attribute float aLen;
  attribute float aSeed;
  attribute float aEnd;
  varying float vFade;

  void main() {
    // Fixed threshold per shaft: as output rises, more of them are drawn.
    if (aSeed > uAmount) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float fall = mod(uTop - position.y + uPhase * (2.0 + aRate * 3.0), uSpan);

    // Head of the shaft, drifting along the slant as it descends.
    vec3 head = vec3(position.x + fall * uSlant, uTop - fall, position.z);
    // Tail trails back up the same line, so the streak lies along its travel.
    vec3 dir = normalize(vec3(uSlant, -1.0, 0.0));
    vec3 p = head - dir * (aEnd * aLen);

    // Faint high up, strongest just before it meets the panels, then cut off
    // at the roofline so nothing passes through the roof.
    float t = fall / uSpan;
    float approach = smoothstep(0.05, 0.88, t);
    float cutoff = smoothstep(1.0, 0.94, t);
    vFade = (0.18 + approach * 0.82) * cutoff;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const RAY_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;

  void main() {
    gl_FragColor = vec4(uColor, vFade * uOpacity);
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
  solar: 0xffc046,
  grid: 0xff8f8f,
  home: 0x76b8ff,
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
  uniform vec3 uColor;
  uniform float uShade;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uSeed;
  uniform vec3 uCamera;
  uniform vec3 uBounds;
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
    vec3 shapeP = vec3(q.x * 0.66, q.y * 1.28, q.z);
    float shape = 1.0 - smoothstep(0.22, 0.58, length(shapeP));
    vec3 wind = vec3(uTime * 0.012 + uSeed, 0.0, uTime * 0.006);
    float detail = noise(q * 3.0 + wind) * 0.56 + noise(q * 6.5 - wind * 1.7) * 0.3 + noise(q * 12.0 + wind * 0.4) * 0.14;
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
    gl_FragColor = vec4(uColor * uShade * (0.68 + (brightness / alpha) * 0.48), min(alpha, 0.82));
  }
`;

export function HouseScene({ state, weather }: { state: HouseState; weather: HouseWeather | null }) {
  const hostRef = useRef<HTMLDivElement>(null);

  const gridImporting = state.gridW >= 0;
  const sourceLabel = state.gridMeasured
    ? gridImporting
      ? "Grid in"
      : "Grid out"
    : "AC input";
  const sourceW = state.gridMeasured ? Math.abs(state.gridW) : state.mainsW;
  const metrics = [
    { label: "Solar", value: formatW(state.solarW), tone: "solar", spot: "roof" },
    { label: "Home", value: formatW(state.homeW), tone: "home", spot: "home" },
    { label: "Battery", value: formatW(Math.abs(state.batteryW)), tone: "battery", spot: "battery" },
    { label: sourceLabel, value: formatW(sourceW), tone: "grid", spot: "service" },
    { label: "AC output", value: formatW(Math.abs(state.acOutW)), tone: "output", spot: "output" },
  ];
  const metricsRef = useRef(metrics);
  const targetRef = useRef({
    color: new THREE.Color("#4ade80"),
    solar: 0,
    strings: Array.from({ length: 4 }, () => 0),
    speed: 0.3,
    cloud: 0.3,
    rain: 0,
    day: 1,
    dusk: 0,
    flow: { solar: 0, grid: 0, home: 0 } as Record<FlowKey, number>,
    packs: 1,
  });

  useEffect(() => {
    const { batteryW, gridW, solarW, strings, peakSolarW, homeW, mainsW, packs } = state;
    let color = "#4ade80";
    if (gridW > 60) color = "#e66767";
    else if (solarW > 60) color = "#c98500";

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
      color: new THREE.Color(color),
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
      dusk: weather?.isDay ? Math.min(1, Math.max(0, (daylightProgress - 0.7) / 0.3)) : 0,
      // Below 5 W is noise, so the run stays dark rather than trickling. Above
      // it the band starts well up the range: against a white wall a faint
      // one is indistinguishable from the cable's own colour.
      flow: {
        solar: solarW >= 5 ? Math.min(0.55 + solarW / 2400, 1) : 0,
        grid: mainsW >= 5 ? Math.min(0.55 + mainsW / 1800, 1) : 0,
        home: homeW >= 5 ? Math.min(0.55 + homeW / 1800, 1) : 0,
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

    const scene = new THREE.Scene();
    const fog = new THREE.Fog(0x0c0d0f, 20, 44);
    scene.fog = fog;
    const skyColor = new THREE.Color(0x0c0d0f);
    scene.background = skyColor;
    const camera = new THREE.PerspectiveCamera(33, host.clientWidth / host.clientHeight, 0.1, 200);
    // Three-quarter from above: we see the panelled slope and one gable end,
    // meeting at the front corner. Held as an orbit about the subject so the
    // pointer tilt can lean it without the framing drifting off.
    const LOOK = new THREE.Vector3(1.6, 2.9, 0.6);
    const HOME = new THREE.Vector3(11.6, 8.0, 12.8);
    const orbit = HOME.clone().sub(LOOK);
    const ORBIT_R = orbit.length();
    const BASE_YAW = Math.atan2(orbit.x, orbit.z);
    const BASE_PITCH = Math.asin(orbit.y / ORBIT_R);
    const aimCamera = (yaw: number, pitch: number) => {
      const cp = Math.cos(pitch);
      camera.position.set(
        LOOK.x + ORBIT_R * cp * Math.sin(yaw),
        LOOK.y + ORBIT_R * Math.sin(pitch),
        LOOK.z + ORBIT_R * cp * Math.cos(yaw),
      );
      camera.lookAt(LOOK);
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
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 4.5;
    // Tight around the house: the planting is grounded by contact blobs, so
    // the map does not have to stretch across the whole plot.
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
    const duskKeyColor = new THREE.Color(0xffb56b);

    // Cool counter-light on the shaded faces, so they read as turned away
    // from the sun rather than as holes.
    const fill = new THREE.DirectionalLight(0x9dbce8, pal.fillIntensity);
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
      track(new THREE.MeshStandardMaterial({ color: c, roughness: 0.98, metalness: 0, flatShading: true })),
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
    // Gloss on the glass.
    //
    // The env map alone cannot do this: every panel shares one normal, so a
    // reflection is uniform across the whole array and reads as a flat tint.
    // A highlight parked near one corner gives each panel its own, and
    // drifting that corner with the view direction - projected onto the
    // panel's own tangent plane - makes the camera tilt sweep it across the
    // glass rather than leaving it painted on.
    // Held outside the compile so the palette can reach it afterwards.
    const glossUniform = { value: pal.gloss };
    panelMat.onBeforeCompile = (shader) => {
      shader.uniforms["uGloss"] = glossUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec2 vGlossUv;
          varying vec2 vGlossOff;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vGlossUv = uv;
          {
            vec4 glossWorld = modelMatrix * vec4( position, 1.0 );
            vec3 glossView = normalize( cameraPosition - glossWorld.xyz );
            vec3 glossN = normalize( mat3( modelMatrix ) * normal );
            vec3 glossUp = abs( glossN.y ) > 0.99 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
            vec3 glossT = normalize( cross( glossUp, glossN ) );
            vec3 glossB = cross( glossN, glossT );
            vGlossOff = vec2( dot( glossView, glossT ), dot( glossView, glossB ) );
          }`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uGloss;
          varying vec2 vGlossUv;
          varying vec2 vGlossOff;`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
          {
            vec2 glossG = vGlossUv - vec2( 0.5 );
            // Toward the panel's lower right on screen. Sliding the ramp by
            // the view offset is what makes a tilt sweep the reflection.
            vec2 glossDir = vec2( -0.7071, 0.7071 );
            float glossAlong = dot( glossG, glossDir ) + dot( vGlossOff, glossDir ) * 0.2;
            // A ramp into the corner, not a spot on it. Glass reflects a
            // whole sky, so it brightens toward the edge it is tilted into;
            // a dot of light on every panel reads as a decal instead.
            float glossFall = smoothstep( 0.02, 0.44, glossAlong );
            // Narrowed across the diagonal, so it stays a corner and does not
            // become a band down two whole edges.
            float glossAcross = abs( dot( glossG, vec2( glossDir.y, -glossDir.x ) ) );
            glossFall *= 1.0 - smoothstep( 0.16, 0.46, glossAcross );
            totalEmissiveRadiance += vec3( 0.30, 0.40, 0.56 ) * glossFall * uGloss;
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
    }> = [];
    const paintPin = (pin: (typeof scenePins)[number], value: string, light: boolean) => {
      const scale = 2;
      const font = "600 18px sans-serif";
      const measure = pin.canvas.getContext("2d")!;
      measure.font = font;
      const width = Math.ceil(Math.max(42, measure.measureText(value).width + 24));
      const height = 30;
      pin.canvas.width = width * scale;
      pin.canvas.height = height * scale;
      const context = pin.canvas.getContext("2d")!;
      context.scale(scale, scale);
      context.beginPath();
      context.roundRect(1, 1, width - 2, height - 2, height / 2);
      context.fillStyle = light ? "rgba(250, 251, 253, 0.92)" : "rgba(25, 30, 37, 0.9)";
      context.fill();
      context.lineWidth = 1;
      context.strokeStyle = `#${pinStyle[pin.spot].toString(16).padStart(6, "0")}`;
      context.stroke();
      context.font = font;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = light ? "#20242a" : "#f4f7fb";
      context.fillText(value, width / 2, height / 2);
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
      const pin = { spot: anchor.spot, sprite, texture, canvas };
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

    const glowGeo = track(new THREE.CircleGeometry(7.5, 48));
    const glowMat = track(
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.06, side: THREE.DoubleSide }),
    );
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(4.0, 0.02, -1.0);
    glow.renderOrder = 3;
    scene.add(glow);

    // ---------------- trees and bushes to the left ----------------
    const flora = new THREE.Group();
    scene.add(flora);

    const coneGeo = track(new THREE.ConeGeometry(1, 1, 9));
    const trunkGeo = track(new THREE.CylinderGeometry(0.08, 0.11, 1, 7));
    // Subdivided once: still faceted under flat shading, but a crown rather
    // than a twenty-sided lump.
    const bushGeo = track(new THREE.IcosahedronGeometry(1, 1));

    const leafMat = () => foliageMats[Math.floor(Math.random() * foliageMats.length)]!;

    /**
     * `bare` drops the lowest ring and stands the crown on a longer trunk.
     *
     * With every ring present the widest one skirts the ground and, from a
     * camera looking down at the scene, hides the trunk completely - so a
     * stand of them reads as a row of cones with nothing holding them up.
     * Only some, so the treeline keeps two silhouettes rather than one.
     */
    const addFir = (x: number, z: number, scale: number, tiers: number, bare: boolean) => {
      const t = new THREE.Group();
      const mat = leafMat();
      const first = bare ? 1 : 0;
      const span = Math.max(tiers - 1, 1);

      const ringY = (i: number) => 0.9 + i * 0.52;
      const ringHeight = (i: number) => 1.02 - (i / span) * 0.34;
      // Long enough to meet the lowest ring that is actually there, with a
      // little overlap so no gap opens between bark and foliage.
      const trunkLen = Math.max(0.9, ringY(first) - ringHeight(first) * 0.5 + 0.12);

      const trunk = solidMesh(trunkGeo, trunkMat);
      trunk.scale.set(1, trunkLen, 1);
      trunk.position.y = trunkLen / 2;
      t.add(trunk);

      for (let i = first; i < tiers; i++) {
        const c = solidMesh(coneGeo, mat);
        const k = i / span;
        c.scale.set(0.98 - k * 0.62, ringHeight(i), 0.98 - k * 0.62);
        c.position.y = ringY(i);
        // A little turn per tier, so the facets of one do not line up with
        // the one below and read as a single extruded shape.
        c.rotation.y = Math.random() * Math.PI;
        t.add(c);
      }
      t.position.set(x, 0, z);
      t.scale.setScalar(scale);
      t.rotation.y = Math.random() * Math.PI;
      flora.add(t);
      addContact(x, z, scale * 0.95);
    };

    /** Rounder broadleaf, so the treeline is not all conifers. */
    const addBroadleaf = (x: number, z: number, scale: number) => {
      const t = new THREE.Group();
      const trunk = solidMesh(trunkGeo, trunkMat);
      trunk.scale.set(1.1, 1.35, 1.1);
      trunk.position.y = 0.68;
      t.add(trunk);
      const crownLobes = [
        [0, 1.82, 0, 0.76, 0.82],
        [0.3, 1.62, 0.16, 0.47, 0.46],
        [-0.27, 1.67, -0.18, 0.43, 0.43],
        [-0.04, 2.12, 0.04, 0.42, 0.52],
      ];
      for (const [lobeX, lobeY, lobeZ, width, height] of crownLobes) {
        const crown = solidMesh(bushGeo, leafMat());
        crown.scale.set(width, height, width * 0.92);
        crown.position.set(lobeX, lobeY, lobeZ);
        crown.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, 0);
        t.add(crown);
      }
      t.position.set(x, 0, z);
      t.scale.setScalar(scale);
      t.rotation.y = Math.random() * Math.PI;
      flora.add(t);
      addContact(x, z, scale * 0.9);
    };

    /** Two or three overlapping masses, the way a shrub actually grows. */
    const addBush = (x: number, z: number, scale: number) => {
      const g = new THREE.Group();
      const mat = leafMat();
      const lobes = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < lobes; i++) {
        const b = solidMesh(bushGeo, mat);
        const w = 0.7 + Math.random() * 0.45;
        b.scale.set(w * 1.1, w * 0.78, w);
        b.position.set(
          (Math.random() - 0.5) * 0.9,
          w * 0.62,
          (Math.random() - 0.5) * 0.9,
        );
        b.rotation.set(Math.random() * 0.4, Math.random() * Math.PI, 0);
        g.add(b);
      }
      g.position.set(x, 0, z);
      g.scale.setScalar(scale);
      flora.add(g);
      addContact(x, z, scale * 1.45);
    };

    // A planter by the door. Local +z is screen left and x past the wall
    // face puts it out on the slab, in front of the elevation. It lives here
    // rather than with the house because it needs the bush geometry and the
    // foliage tones, which the planting section owns.
    {
      const potX = 2.0;
      const potZ = 1.8;
      const potMat = leafMat();

      const potGeo = track(new THREE.CylinderGeometry(0.22, 0.16, 0.34, 12));
      potGeo.translate(potX, PLINTH + 0.17, potZ);
      house.add(solidMesh(potGeo, plinthMat));

      const rimGeo = track(new THREE.CylinderGeometry(0.245, 0.245, 0.06, 12));
      rimGeo.translate(potX, PLINTH + 0.32, potZ);
      house.add(solidMesh(rimGeo, plinthMat));

      // Three lobes, the same way the ground bushes are built.
      for (let i = 0; i < 3; i++) {
        const b = new THREE.Mesh(bushGeo, potMat);
        const w = 0.17 + Math.random() * 0.1;
        b.scale.set(w * 1.15, w * 0.95, w);
        b.position.set(
          potX + (Math.random() - 0.5) * 0.22,
          PLINTH + 0.46 + (Math.random() - 0.5) * 0.12,
          potZ + (Math.random() - 0.5) * 0.22,
        );
        b.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, 0);
        b.castShadow = true;
        b.receiveShadow = true;
        house.add(b);
      }
    }

    // Planted in copses rather than sprinkled evenly. Uniform rejection
    // sampling gives a texture, not a landscape: real planting comes in
    // stands with open ground between them, and the clearings are what let
    // the house read as the subject.
    const HOUSE_X = 4.0;
    const HOUSE_Z = -1.0;

    // Nothing plants in the sightline. The old rule was an axis-aligned box,
    // which only half covered it because the camera does not look down an
    // axis: this takes the actual house-to-camera direction and keeps a wedge
    // clear along it, widening with distance so a distant tree - which stands
    // taller in frame - needs more room to miss the house.
    const viewX = camera.position.x - HOUSE_X;
    const viewZ = camera.position.z - HOUSE_Z;
    const viewLen = Math.hypot(viewX, viewZ);
    const vx = viewX / viewLen;
    const vz = viewZ / viewLen;
    const inSightline = (x: number, z: number) => {
      const dx = x - HOUSE_X;
      const dz = z - HOUSE_Z;
      const along = dx * vx + dz * vz;
      if (along <= 0) return false;
      const across = Math.abs(dx * -vz + dz * vx);
      return across < 3.6 + along * 0.22;
    };

    // The slab's footprint in world terms, plus a margin. Circles around the
    // house and the garage left the corners of an eleven-unit slab uncovered,
    // and planting turned up standing on it.
    const PLOT_M = 1.3;
    const clearOfHouse = (x: number, z: number) =>
      (x < -3 - PLOT_M || x > 8 + PLOT_M || z < -4 - PLOT_M || z > 2 + PLOT_M) &&
      !inSightline(x, z);

    // Track footprints so a bush never grows out of a tree trunk.
    const taken: Array<[number, number, number]> = [];
    const PLANT_GAP = 0.55;
    const clearOfPlants = (x: number, z: number, r: number) =>
      taken.every(([px, pz, pr]) => Math.hypot(x - px, z - pz) > r + pr + PLANT_GAP);

    // Copse centres first, kept well apart so the stands stay distinct.
    const copses: Array<[number, number]> = [];
    let cGuard = 0;
    while (copses.length < 5 && cGuard++ < 400) {
      const x = -17 + Math.random() * 29;
      const z = -12 + Math.random() * 17;
      if (!clearOfHouse(x, z)) continue;
      if (copses.some(([px, pz]) => Math.hypot(x - px, z - pz) < 7)) continue;
      copses.push([x, z]);
    }

    const plant = (x: number, z: number, big: boolean) => {
      const roll = big ? Math.random() * 0.72 : 0.72 + Math.random() * 0.28;
      const scale = roll < 0.72 ? 0.65 + Math.random() * 0.7 : 0.22 + Math.random() * 0.24;
      const radius = roll < 0.72 ? scale * 1.35 : scale * 1.7;
      if (!clearOfHouse(x, z) || !clearOfPlants(x, z, radius)) return false;
      if (roll < 0.46) addFir(x, z, scale, 4 + (Math.random() < 0.45 ? 1 : 0), Math.random() < 0.45);
      else if (roll < 0.72) addBroadleaf(x, z, scale);
      else addBush(x, z, scale);
      taken.push([x, z, radius]);
      return true;
    };

    for (const [cx, cz] of copses) {
      const want = 4 + Math.floor(Math.random() * 4);
      let got = 0;
      let guard = 0;
      while (got < want && guard++ < 120) {
        // Denser at the centre than the rim: sqrt would spread them evenly
        // over the disc, which is the scatter we are trying to get away from.
        const a = Math.random() * Math.PI * 2;
        const r = Math.pow(Math.random(), 1.7) * 3.4;
        // Trees make the stand, undergrowth fills between them.
        if (plant(cx + Math.cos(a) * r, cz + Math.sin(a) * r, got < want - 2)) got++;
      }
    }

    // A handful of strays, so the stands do not look planted to a plan.
    let strays = 0;
    let sGuard = 0;
    while (strays < 4 && sGuard++ < 200) {
      const x = -19 + Math.random() * 33;
      const z = -13 + Math.random() * 20;
      if (Math.hypot(x - HOUSE_X, z - HOUSE_Z) < 8) continue;
      if (plant(x, z, Math.random() < 0.5)) strays++;
    }

    // ---------------- clouds ----------------
    const clouds = new THREE.Group();
    scene.add(clouds);
    // Bounded density fields preserve the depth and self-occlusion cues of
    // volumetric clouds without turning the entire header into a raymarch.
    const cloudVolumes: Array<{ mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> }> = [];
    const viewForward = LOOK.clone().sub(camera.position).normalize();
    const viewRight = new THREE.Vector3().crossVectors(viewForward, new THREE.Vector3(0, 1, 0)).normalize();
    const cloudLayouts: ReadonlyArray<{
      offset: number;
      height: number;
      scale: number;
      shade: number;
      lobes: ReadonlyArray<readonly [number, number, number, number, number]>;
    }> = [
      {
        offset: -12.5,
        height: 3.55,
        scale: 1.2,
        shade: 0.84,
        lobes: [[-1.65, -0.1, 0.18, 0.5, 0.52], [-0.85, 0.1, -0.12, 0.74, 0.8], [0, 0.38, -0.2, 1, 1], [0.9, 0.12, 0.14, 0.76, 0.76], [1.7, -0.08, 0.06, 0.48, 0.5]],
      },
      {
        offset: -3.2,
        height: 5.05,
        scale: 0.45,
        shade: 1.08,
        lobes: [[-0.9, 0.05, 0.08, 0.7, 0.54], [0, 0.2, -0.12, 0.92, 0.76], [0.82, 0.02, 0.1, 0.64, 0.5]],
      },
      {
        offset: 5.4,
        height: 3.25,
        scale: 0.98,
        shade: 0.94,
        lobes: [[-1.22, -0.15, 0.2, 0.66, 0.58], [-0.42, 0.3, -0.1, 0.88, 1.12], [0.5, 0.12, 0.12, 0.82, 0.84], [1.2, -0.08, -0.04, 0.58, 0.52]],
      },
      {
        offset: 14.6,
        height: 4.5,
        scale: 0.52,
        shade: 0.76,
        lobes: [[-0.72, -0.1, 0.12, 0.66, 0.64], [0.05, 0.38, -0.15, 0.96, 1.2], [0.82, 0.03, 0.08, 0.62, 0.56]],
      },
    ];

    for (const { offset, height, scale, shade, lobes } of cloudLayouts) {
      const centre = LOOK.clone().addScaledVector(viewForward, 18).addScaledVector(viewRight, offset);
      const drift = 0.05 + Math.random() * 0.13;
      for (const [lobeX, lobeY, lobeZ, lobeWidth, lobeHeight] of lobes) {
        const bounds = new THREE.Vector3(2.45 * scale * lobeWidth, 1.4 * scale * lobeHeight, 1.3 * scale * lobeWidth);
        const uniforms: Record<string, THREE.IUniform> = {
          uColor: { value: new THREE.Color(pal.cloud) },
          uShade: { value: shade },
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
    const RAY_SLANT = 0.42;
    const RAY_TOP = 13.5;
    const RAY_SPAN = 9.2;
    const ROOF_X = 4.0;
    const ROOF_Z = -1.0;

    const makeRays = (count: number) => {
      // Two vertices per shaft: head and tail.
      const pos = new Float32Array(count * 2 * 3);
      const rates = new Float32Array(count * 2);
      const lens = new Float32Array(count * 2);
      const seeds = new Float32Array(count * 2);
      const ends = new Float32Array(count * 2);

      const drift = Math.tan(RAY_SLANT) * RAY_SPAN;
      for (let i = 0; i < count; i++) {
        // Chosen so that after drifting it arrives over the roof.
        const x = ROOF_X + (Math.random() - 0.5) * 5.6 - drift * 0.55 - 1.9;
        const y = Math.random() * RAY_SPAN;
        const z = ROOF_Z + (Math.random() - 0.5) * 4.6;
        const rate = Math.random();
        const seed = Math.random();
        // Strongly varied: short dashes through to long streaks.
        const len = 0.5 + Math.pow(Math.random(), 1.7) * 4.5;

        for (let e = 0; e < 2; e++) {
          const v = i * 2 + e;
          pos[v * 3] = x;
          pos[v * 3 + 1] = y;
          pos[v * 3 + 2] = z;
          rates[v] = rate;
          lens[v] = len;
          seeds[v] = seed;
          ends[v] = e;
        }
      }

      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("aRate", new THREE.BufferAttribute(rates, 1));
      geo.setAttribute("aLen", new THREE.BufferAttribute(lens, 1));
      geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
      geo.setAttribute("aEnd", new THREE.BufferAttribute(ends, 1));

      const uniforms = {
        uPhase: { value: 0 },
        uColor: { value: new THREE.Color("#e8b355") },
        uOpacity: { value: 0 },
        uAmount: { value: 1 },
        uSlant: { value: Math.tan(RAY_SLANT) },
        uTop: { value: RAY_TOP },
        uSpan: { value: RAY_SPAN },
      };
      const mat = track(
        new THREE.ShaderMaterial({
          uniforms,
          vertexShader: RAY_VERT,
          fragmentShader: RAY_FRAG,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          blending: THREE.AdditiveBlending,
        }),
      );
      return { points: new THREE.LineSegments(geo, mat), uniforms };
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
      for (const cloud of cloudVolumes) (cloud.uniforms.uColor!.value as THREE.Color).setHex(p.cloud);
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

    // Parallax: the scene drifts slower than the page, so the header has depth
    // behind the cards scrolling over it.
    let parallax = 0;
    const onScroll = () => {
      parallax = Math.min(window.scrollY, 900) * 0.28;
      renderer.domElement.style.transform = "translate3d(0, " + parallax + "px, 0)";
    };
    if (!reduced.matches) {
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }

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
      wantX = (e.clientX / window.innerWidth - 0.5) * 2;
      wantY = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    if (!reduced.matches) window.addEventListener("pointermove", onPointer, { passive: true });

    const resize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
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
      for (const cloud of cloudVolumes) blendEnvironment(cloud.uniforms.uColor!.value as THREE.Color, environment.cloud);

      const keyPosition = dayKeyPosition.clone().lerp(duskKeyPosition, target.dusk);
      key.position.lerp(keyPosition, 0.025);
      key.color.copy(new THREE.Color(pal.keyColor)).lerp(duskKeyColor, duskAmount);
      if (pal === LIGHT) key.color.lerp(LIGHT_NIGHT_KEY, nightAmount);
      else key.color.lerp(DARK_NIGHT_KEY, nightAmount);
      if (pal === LIGHT) {
        hemi.color.copy(new THREE.Color(pal.hemiSky)).lerp(LIGHT_NIGHT_HEMI_SKY, nightAmount);
        hemi.groundColor.copy(new THREE.Color(pal.hemiGround)).lerp(LIGHT_NIGHT_HEMI_GROUND, nightAmount);
      }
      const nightLightLevel = pal === LIGHT ? 0.32 : 0.48;
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
      if (Math.abs(target.dusk - shadowDusk) > 0.05) {
        shadowDusk = target.dusk;
        renderer.shadowMap.needsUpdate = true;
      }

      glowMat.color.lerp(target.color, 0.03);
      rays.uniforms.uColor.value.lerp(new THREE.Color("#e8b355"), 0.03);

      const solar = target.solar;
      // The array brightens with what it is making. Cool, and gently: the
      // cell lines do most of the work, so the glass never leaves its hue.
      panelBanks.forEach((bank, index) => {
        const stringPower = target.strings[index] ?? solar;
        bank.face.emissiveIntensity += (stringPower * 0.3 - bank.face.emissiveIntensity) * 0.04;
        bank.cells.opacity += (0.18 + stringPower * 0.55 - bank.cells.opacity) * 0.04;
        bank.edges.opacity += (0.35 + stringPower * 0.45 - bank.edges.opacity) * 0.04;
      });
      glowMat.opacity = 0.015 + solar * 0.025;

      // A light suggestion of direct sun, not a weather effect. The warmer
      // key light owns golden hour; these thin out before it takes over.
      const rayTarget =
        target.day * (0.45 + (1 - target.cloud) * 0.55) * (0.06 + solar * 0.16) * (1 - target.dusk * 0.8);
      rays.uniforms.uOpacity.value += (rayTarget - rays.uniforms.uOpacity.value) * 0.03;
      // Fraction of shafts drawn, straight from PV output.
      rays.uniforms.uAmount.value += (Math.min(0.08 + solar * 0.3, 0.38) - rays.uniforms.uAmount.value) * 0.03;
      // Sunnier means the shafts sweep through faster.
      raySpeed += (0.3 + solar * 1.35 - raySpeed) * 0.04;

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
        c.phase += dt * (0.25 + amount.value * 0.85);
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

      renderer.render(scene, camera);
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

    if (reduced.matches) render(0);
    else tick();

    return () => {
      cancelAnimationFrame(frame);
      timer.dispose();
      window.removeEventListener("scroll", onScroll);
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
