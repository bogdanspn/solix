import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * The page header: a low-poly house with its own weather.
 *
 * Built procedurally rather than loaded from a model, so it costs a few
 * hundred bytes and, more usefully, can be wired to the live system and the
 * live forecast. Roof panels brighten with real PV output; sun rays thin out
 * as real cloud cover rises; clouds drift in proportion to that cover; rain
 * falls when the forecast says it will; and at night the sun goes away.
 *
 * Surfaces are filled with near-background tones so the wireframe reads as a
 * solid object rather than a see-through cage.
 *
 * Stops entirely for `prefers-reduced-motion` or a hidden tab.
 */

export interface HouseState {
  batteryW: number;
  gridW: number;
  solarW: number;
  peakSolarW: number;
}

export interface HouseWeather {
  cloudPct: number;
  precipPct: number;
  isDay: boolean;
  radiation: number;
}

interface Palette {
  door: number;
  plinth: number;
  wall: number;
  roof: number;
  edge: number;
  grid: number;
  foliage: number;
  trunk: number;
  cloud: number;
}

const DARK: Palette = {
  door: 0x2f3541,
  plinth: 0x22262d,
  wall: 0x181b21,
  roof: 0x101318,
  edge: 0x9aa3b2,
  grid: 0x424a57,
  foliage: 0x15241c,
  trunk: 0x1d1a17,
  cloud: 0x2a2f38,
};

const LIGHT: Palette = {
  door: 0xc7cdd6,
  plinth: 0xdde1e8,
  wall: 0xf2f4f7,
  roof: 0xe4e8ee,
  edge: 0x8d97a6,
  grid: 0xbcc3ce,
  foliage: 0xdfe9e0,
  trunk: 0xd8d2ca,
  cloud: 0xffffff,
};

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

export function HouseScene({ state, weather }: { state: HouseState; weather: HouseWeather | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef({
    color: new THREE.Color("#4ade80"),
    solar: 0,
    speed: 0.3,
    cloud: 0.3,
    rain: 0,
    day: 1,
  });

  useEffect(() => {
    const { batteryW, gridW, solarW, peakSolarW } = state;
    let color = "#4ade80";
    if (gridW > 60) color = "#e66767";
    else if (solarW > 60) color = "#c98500";

    const magnitude = Math.max(Math.abs(batteryW), Math.abs(gridW), solarW);
    targetRef.current = {
      color: new THREE.Color(color),
      solar: Math.min(solarW / Math.max(peakSolarW, 800), 1),
      speed: 0.2 + Math.min(magnitude / 2500, 1) * 0.5,
      cloud: weather ? weather.cloudPct / 100 : 0.3,
      // Only actually raining above a meaningful probability.
      rain: weather && weather.precipPct >= 40 ? Math.min((weather.precipPct - 40) / 50, 1) : 0,
      day: weather ? (weather.isDay ? 1 : 0) : 1,
    };
  }, [state, weather]);

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
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const fogFor = (p: Palette) => (p === LIGHT ? 0xeceef1 : 0x0c0d0f);
    const fog = new THREE.Fog(0x0c0d0f, 18, 38);
    scene.fog = fog;
    const camera = new THREE.PerspectiveCamera(33, host.clientWidth / host.clientHeight, 0.1, 200);
    // Three-quarter from above: we see the panelled slope and one gable end,
    // meeting at the front corner.
    camera.position.set(11.6, 8.0, 12.8);
    camera.lookAt(1.6, 2.9, 0.6);

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(x: T): T => {
      disposables.push(x);
      return x;
    };

    let pal = document.documentElement.dataset["theme"] === "light" ? LIGHT : DARK;
    fog.color.setHex(fogFor(pal));

    // Solid fills write depth, so the wireframe reads as an object and the
    // rays behind it are properly occluded.
    const solid = (color: number) =>
      track(new THREE.MeshBasicMaterial({ color, transparent: false, depthWrite: true, fog: true }));
    const wireMat = track(
      new THREE.LineBasicMaterial({ color: pal.edge, transparent: true, opacity: 0.85, fog: true }),
    );

    const wallMat = solid(pal.wall);
    const roofMat = solid(pal.roof);
    const foliageMat = solid(pal.foliage);
    const trunkMat = solid(pal.trunk);
    const plinthMat = solid(pal.plinth);
    const doorMat = solid(pal.door);

    const shell = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(geo, mat));
      g.add(new THREE.LineSegments(track(new THREE.EdgesGeometry(geo, 1)), wireMat));
      return g;
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

    const baseGeo = track(new THREE.BoxGeometry(4.0, PLINTH, 6.0));
    baseGeo.translate(0, PLINTH / 2, 0);
    house.add(shell(baseGeo, plinthMat));

    const wallGeo = track(new THREE.BoxGeometry(3.0, BASE, 5.0));
    wallGeo.translate(0, PLINTH + BASE / 2, 0);
    house.add(shell(wallGeo, wallMat));

    const roofGeo = track(roofPrism(EAVE * 2, RISE, 5.4));
    roofGeo.translate(0, PLINTH + BASE, 0);
    house.add(shell(roofGeo, roofMat));

    // Door and window share a head height, as they would on a real elevation.
    const DOOR_H = 1.35;
    const WIN_H = 0.66;
    const HEAD = PLINTH + DOOR_H;

    const doorGeo = track(new THREE.BoxGeometry(0.07, DOOR_H, 0.72));
    doorGeo.translate(1.51, PLINTH + DOOR_H / 2, 0.95);
    house.add(shell(doorGeo, doorMat));

    const winGeo = track(new THREE.BoxGeometry(0.07, WIN_H, 0.82));
    winGeo.translate(1.51, HEAD - WIN_H / 2, -0.95);
    house.add(shell(winGeo, doorMat));

    // ---------------- solar panels on the slope ----------------
    const slopeLen = Math.hypot(EAVE, RISE);
    const cosS = EAVE / slopeLen;
    const sinS = RISE / slopeLen;

    const panelMat = track(
      new THREE.MeshBasicMaterial({ color: 0xc98500, transparent: true, opacity: 0.2, side: THREE.DoubleSide }),
    );
    const panelEdgeMat = track(
      new THREE.LineBasicMaterial({ color: 0xc98500, transparent: true, opacity: 0.5 }),
    );

    const panelGeo = track(new THREE.PlaneGeometry(0.86, 1.06));
    panelGeo.rotateX(-Math.PI / 2);
    panelGeo.rotateZ(-Math.asin(sinS));
    const panelEdges = track(new THREE.EdgesGeometry(panelGeo));

    const panels = new THREE.Group();
    house.add(panels);

    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 2; row++) {
        const p = new THREE.Group();
        p.add(new THREE.Mesh(panelGeo, panelMat), new THREE.LineSegments(panelEdges, panelEdgeMat));
        // Rows 1.16 apart for a 1.02-long panel: previously 1.02 apart for a
        // 1.15-long panel, so consecutive rows intersected.
        const d = 0.62 + row * 0.94;
        p.position.set(d * cosS + sinS * 0.05, RIDGE - d * sinS + cosS * 0.05, (col - 1.5) * 1.22);
        panels.add(p);
      }
    }

    // ---------------- trees and bushes to the left ----------------
    const flora = new THREE.Group();
    scene.add(flora);

    const coneGeo = track(new THREE.ConeGeometry(1, 1, 6));
    const trunkGeo = track(new THREE.CylinderGeometry(0.08, 0.11, 1, 5));
    const bushGeo = track(new THREE.IcosahedronGeometry(1, 0));

    const addFir = (x: number, z: number, scale: number, tiers: number) => {
      const t = new THREE.Group();
      const trunk = shell(trunkGeo, trunkMat);
      trunk.scale.set(1, 0.9, 1);
      trunk.position.y = 0.45;
      t.add(trunk);
      for (let i = 0; i < tiers; i++) {
        const c = shell(coneGeo, foliageMat);
        c.scale.set(0.95 - i * 0.2, 1.0 - i * 0.12, 0.95 - i * 0.2);
        c.position.y = 0.95 + i * 0.58;
        t.add(c);
      }
      t.position.set(x, 0, z);
      t.scale.setScalar(scale);
      t.rotation.y = Math.random() * Math.PI;
      flora.add(t);
    };

    /** Rounder broadleaf, so the treeline is not all conifers. */
    const addBroadleaf = (x: number, z: number, scale: number) => {
      const t = new THREE.Group();
      const trunk = shell(trunkGeo, trunkMat);
      trunk.scale.set(1.1, 1.35, 1.1);
      trunk.position.y = 0.68;
      t.add(trunk);
      const crown = shell(bushGeo, foliageMat);
      crown.scale.set(0.85, 0.95, 0.85);
      crown.position.y = 1.85;
      t.add(crown);
      const crown2 = shell(bushGeo, foliageMat);
      crown2.scale.set(0.52, 0.5, 0.52);
      crown2.position.set(0.24, 1.62, 0.14);
      t.add(crown2);
      t.position.set(x, 0, z);
      t.scale.setScalar(scale);
      t.rotation.y = Math.random() * Math.PI;
      flora.add(t);
    };

    const addBush = (x: number, z: number, scale: number) => {
      const b = shell(bushGeo, foliageMat);
      b.scale.set(scale * 1.15, scale * 0.8, scale);
      b.position.set(x, scale * 0.6, z);
      b.rotation.y = Math.random() * Math.PI;
      flora.add(b);
    };

    // Scattered by rejection sampling rather than hand-placed: positions are
    // random across the whole plot, with anything landing on the house or its
    // approach discarded. Hand-listing coordinates is what produced a clump.
    const HOUSE_X = 4.0;
    const clearOfHouse = (x: number, z: number) =>
      Math.hypot(x - HOUSE_X, z + 1) > 4.6 && !(x > 1.2 && z > 1.4 && z < 8);

    // Track footprints so a bush never grows out of a tree trunk.
    const taken: Array<[number, number, number]> = [];
    const PLANT_GAP = 0.55;
    const clearOfPlants = (x: number, z: number, r: number) =>
      taken.every(([px, pz, pr]) => Math.hypot(x - px, z - pz) > r + pr + PLANT_GAP);

    let placed = 0;
    let guard = 0;
    while (placed < 30 && guard++ < 900) {
      const x = -19 + Math.random() * 33;
      const z = -13 + Math.random() * 20;
      if (!clearOfHouse(x, z)) continue;

      // Thin the planting out near the house so it never crowds the subject.
      const near = Math.hypot(x - HOUSE_X, z);
      if (near < 8 && Math.random() > 0.45) continue;

      const roll = Math.random();
      const scale = roll < 0.72 ? 0.65 + Math.random() * 0.7 : 0.22 + Math.random() * 0.24;
      const radius = roll < 0.72 ? scale * 1.35 : scale * 1.7;
      if (!clearOfPlants(x, z, radius)) continue;

      if (roll < 0.46) addFir(x, z, scale, 3 + (Math.random() < 0.4 ? 1 : 0));
      else if (roll < 0.72) addBroadleaf(x, z, scale);
      else addBush(x, z, scale);
      taken.push([x, z, radius]);
      placed++;
    }

    // ---------------- ground ----------------
    // 46 units over 46 divisions: one world unit per cell, so the plinth can
    // land exactly on cell boundaries.
    const grid = new THREE.GridHelper(46, 46, pal.grid, pal.grid);
    const gridMat = grid.material as THREE.LineBasicMaterial;
    gridMat.transparent = true;
    gridMat.opacity = 0.7;
    scene.add(grid);
    disposables.push(grid.geometry, gridMat);

    const glowGeo = track(new THREE.CircleGeometry(7.5, 48));
    const glowMat = track(
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.06, side: THREE.DoubleSide }),
    );
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(4.0, 0.02, -1.0);
    scene.add(glow);

    // ---------------- clouds ----------------
    const clouds = new THREE.Group();
    scene.add(clouds);
    const cloudMat = track(
      new THREE.MeshBasicMaterial({
        color: pal.cloud,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        fog: true,
      }),
    );
    // Icosahedra rather than smooth spheres: faceted reads as low-poly and
    // matches the wireframe language of the house.
    // A six-sided prism with its hex faces toward the viewer: the silhouette
    // is a hexagon, and stretching it along x makes the elongated plate the
    // mockup calls for. Strings of spheres read as bubbles, not cloud.
    const puffGeo = track(new THREE.CylinderGeometry(1, 1, 0.45, 6));
    puffGeo.rotateX(Math.PI / 2);
    puffGeo.rotateZ(Math.PI / 6);

    // The camera sits 39 degrees off axis, so a cloud built along world X
    // recedes diagonally. Turning each one to face the camera makes its long
    // axis run horizontally on screen, which is what actually reads as flat.
    const cloudFacing = Math.atan2(
      camera.position.x - 1.6,
      camera.position.z - 0.6,
    );

    const CLOUDS = 10;
    for (let i = 0; i < CLOUDS; i++) {
      const c = new THREE.Group();
      // Between three and six puffs at varied scales, so no two clouds share
      // a silhouette. A fixed count and size made them read as a repeated
      // stamp.
      // One to three plates per cloud, offset and overlapping only slightly,
      // so each hexagon stays legible instead of merging into a lumpy mass.
      const puffs = 1 + Math.floor(Math.random() * 3);
      for (let k = 0; k < puffs; k++) {
        const m = new THREE.Mesh(puffGeo, cloudMat);
        const w = 0.55 + Math.random() * 0.7;
        m.position.set(
          (k - (puffs - 1) / 2) * (w * 1.55),
          (Math.random() - 0.5) * 0.3,
          (Math.random() - 0.5) * 0.5,
        );
        // Long and low: an elongated hexagon rather than a ball.
        m.scale.set(w * 1.45, w * 0.62, 1);
        c.add(m);
      }
      c.position.set(
        -28 + Math.random() * 58,
        // Kept low enough to stay inside the band at this focal length.
        5.0 + Math.random() * 2.0,
        -5 - Math.random() * 12,
      );
      c.rotation.set(0, cloudFacing, 0);
      c.scale.setScalar(0.5 + Math.random() * 0.55);
      c.userData["drift"] = 0.05 + Math.random() * 0.13;
      clouds.add(c);
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
    scene.add(rays.points);

    const rain = makeRain(320);
    scene.add(rain.points);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    // Parallax: the scene drifts slower than the page, so the header has depth
    // behind the cards scrolling over it.
    let parallax = 0;
    const onScroll = () => {
      parallax = Math.min(window.scrollY, 900) * 0.28;
      renderer.domElement.style.transform = `translate3d(0, ${parallax}px, 0)`;
    };
    if (!reduced.matches) {
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }

    const resize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      renderer.setSize(host.clientWidth, host.clientHeight);
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const clock = new THREE.Clock();
    let frame = 0;
    let t = 0;
    // Eased speeds live here; the shaders only ever see accumulated phase.
    let raySpeed = 0.4;
    let rayPhase = 0;
    let rainPhase = 0;

    const render = (dt: number) => {
      const target = targetRef.current;

      const nextPal = document.documentElement.dataset["theme"] === "light" ? LIGHT : DARK;
      if (nextPal !== pal) {
        pal = nextPal;
        plinthMat.color.setHex(pal.plinth);
        doorMat.color.setHex(pal.door);
        wallMat.color.setHex(pal.wall);
        roofMat.color.setHex(pal.roof);
        foliageMat.color.setHex(pal.foliage);
        trunkMat.color.setHex(pal.trunk);
        wireMat.color.setHex(pal.edge);
        gridMat.color.setHex(pal.grid);
        cloudMat.color.setHex(pal.cloud);
        fog.color.setHex(fogFor(pal));
      }

      glowMat.color.lerp(target.color, 0.03);
      rays.uniforms.uColor.value.lerp(new THREE.Color("#e8b355"), 0.03);

      const solar = target.solar;
      panelMat.opacity += (0.14 + solar * 0.5 - panelMat.opacity) * 0.04;
      panelEdgeMat.opacity += (0.35 + solar * 0.5 - panelEdgeMat.opacity) * 0.04;
      glowMat.opacity = 0.03 + solar * 0.04;

      // Rays are gated by daylight AND thinned by real cloud cover, so a
      // 100%-overcast noon looks overcast rather than blazing.
      // Cloud thins the shafts rather than removing them. The previous curve
      // bottomed out near 0.18 before the sprite falloff, which was invisible.
      const rayTarget = target.day * (0.62 + (1 - target.cloud) * 0.38) * (0.5 + solar * 0.5);
      rays.uniforms.uOpacity.value += (rayTarget - rays.uniforms.uOpacity.value) * 0.03;
      // Fraction of shafts drawn, straight from PV output.
      rays.uniforms.uAmount.value += (Math.min(0.28 + solar * 0.85, 1) - rays.uniforms.uAmount.value) * 0.03;
      // Sunnier means the shafts sweep through faster.
      raySpeed += (0.3 + solar * 1.35 - raySpeed) * 0.04;

      rain.uniforms.uOpacity.value += (target.rain * 0.55 - rain.uniforms.uOpacity.value) * 0.03;

      cloudMat.opacity += (0.06 + target.cloud * 0.34 - cloudMat.opacity) * 0.03;
      for (const c of clouds.children) {
        c.position.x += (c.userData["drift"] as number) * dt;
        if (c.position.x > 24) c.position.x = -24;
      }

      // Fixed, grid-aligned: any sway left it sitting askew on the plinth.
      house.rotation.y = -Math.PI / 2;

      renderer.render(scene, camera);
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (document.hidden) return;
      // A backgrounded tab returns a huge delta; clamping keeps the phase from
      // leaping a hundred cycles on the first frame back.
      const dt = Math.min(clock.getDelta(), 0.1);
      t += dt;
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
      window.removeEventListener("scroll", onScroll);
      observer.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className="house" ref={hostRef} aria-hidden />;
}
