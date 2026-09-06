import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createSolarbank } from "./SolarbankModel.ts";
import { createPlug } from "./PlugModel.ts";

const BATTERY_COLOR = 0x8294a5;

function solarPanels() {
  const group = new THREE.Group();
  const frame = new THREE.MeshStandardMaterial({ color: 0x8e989d, metalness: 0.8, roughness: 0.3 });
  const backing = new THREE.MeshStandardMaterial({ color: 0x647889, roughness: 0.5 });
  const cell = new THREE.MeshStandardMaterial({ color: 0x1a3448, metalness: 0.24, roughness: 0.24 });
  const cellGeometry = new THREE.PlaneGeometry(0.111, 0.103);
  for (const side of [-1, 1]) {
    const panel = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.78, 1.18, 0.045), frame);
    rim.castShadow = true;
    panel.add(rim);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.744, 1.144, 0.012), backing);
    glass.position.z = 0.025;
    panel.add(glass);
    for (let row = 0; row < 10; row++) {
      for (let column = 0; column < 6; column++) {
        const tile = new THREE.Mesh(cellGeometry, cell);
        tile.position.set((column - 2.5) * 0.12, (row - 4.5) * 0.112, 0.032);
        panel.add(tile);
      }
    }
    const railGeometry = new THREE.BoxGeometry(0.82, 0.024, 0.055);
    for (const height of [-0.35, 0.35]) {
      const rail = new THREE.Mesh(railGeometry, frame);
      rail.position.set(0, height, -0.045);
      panel.add(rail);
    }
    panel.rotation.x = -0.32;
    panel.position.set(side * 0.415, 0.58, side * -0.06);
    group.add(panel);
  }
  return group;
}

function expansionBatteries(count: number) {
  const group = new THREE.Group();
  const visibleCount = Math.max(1, Math.min(6, Math.floor(count)));
  const columns = Math.min(3, visibleCount);
  const rows = Math.ceil(visibleCount / columns);
  const metal = new THREE.MeshStandardMaterial({ color: BATTERY_COLOR, roughness: 0.48, metalness: 0.48 });
  const edge = new THREE.MeshStandardMaterial({ color: 0x394653, roughness: 0.7 });
  const bodyGeometry = new THREE.BoxGeometry(0.64, 0.42, 0.36);
  const topGeometry = new THREE.BoxGeometry(0.60, 0.015, 0.32);
  for (let index = 0; index < visibleCount; index++) {
    const module = new THREE.Group();
    const body = new THREE.Mesh(bodyGeometry, metal);
    body.position.y = 0.22;
    body.castShadow = true;
    body.receiveShadow = true;
    const top = new THREE.Mesh(topGeometry, edge);
    top.position.y = 0.436;
    module.add(body, top);
    module.position.set((index % columns - (columns - 1) / 2) * 0.78, 0, (Math.floor(index / columns) - (rows - 1) / 2) * 0.55);
    group.add(module);
  }
  return group;
}

export default function ProductScene({ kind, soc, count = 1 }: { kind: "solarbank" | "panels" | "expansions" | "plug"; soc?: number; count?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const charge = useRef(soc);
  charge.current = soc;
  const refreshDisplay = useRef<(() => void) | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute("aria-hidden", "true");
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x7d858b, 2.4));
    const key = new THREE.DirectionalLight(0xfff7ed, 3.5);
    key.position.set(-3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -2;
    key.shadow.camera.right = 2;
    key.shadow.camera.top = 2;
    key.shadow.camera.bottom = -2;
    key.shadow.normalBias = 0.025;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdceeff, 1.5);
    fill.position.set(3, 2, -2);
    scene.add(fill);

    const bank = kind === "solarbank" ? createSolarbank({ color: BATTERY_COLOR }) : null;
    const model = bank?.group ?? (kind === "plug" ? createPlug() : kind === "expansions" ? expansionBatteries(count) : solarPanels());
    scene.add(model);
    const textures: THREE.Texture[] = [];
    let displayCanvas: HTMLCanvasElement | null = null;
    let displayTexture: THREE.CanvasTexture | null = null;
    if (bank || kind === "plug") {
      const brandCanvas = document.createElement("canvas");
      brandCanvas.width = 512;
      brandCanvas.height = 192;
      const brand = brandCanvas.getContext("2d")!;
      brand.fillStyle = kind === "plug" ? "#b6b9b6" : "#f5f5f2";
      brand.textAlign = "center";
      brand.font = "500 72px sans-serif";
      brand.fillText("ANKER", 256, 80);
      brand.font = "32px sans-serif";
      brand.fillText("S O L I X", 256, 136);
      const brandTexture = new THREE.CanvasTexture(brandCanvas);
      brandTexture.colorSpace = THREE.SRGBColorSpace;
      textures.push(brandTexture);
      const badge = new THREE.Mesh(new THREE.PlaneGeometry(kind === "plug" ? 0.38 : 0.3, kind === "plug" ? 0.143 : 0.113), new THREE.MeshBasicMaterial({ map: brandTexture, transparent: true, depthWrite: false }));
      badge.position.set(0, kind === "plug" ? 0.93 : 0.46, kind === "plug" ? 0.412 : 0.216);
      model.add(badge);
    }
    if (bank) {
      displayCanvas = document.createElement("canvas");
      displayCanvas.width = 512;
      displayCanvas.height = 128;
      displayTexture = new THREE.CanvasTexture(displayCanvas);
      displayTexture.colorSpace = THREE.SRGBColorSpace;
      textures.push(displayTexture);
      const display = new THREE.Mesh(new THREE.PlaneGeometry(0.43, 0.106), new THREE.MeshBasicMaterial({ map: displayTexture }));
      display.position.set(0, 0.694, 0.223);
      model.add(display);
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: kind === "plug" ? 0.06 : 0.13 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.014;
    floor.receiveShadow = true;
    scene.add(floor);

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 30);
    camera.position.set(-2.4, 1.8, 4);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, kind === "solarbank" ? 0.4 : kind === "expansions" ? 0.22 : 0.57, 0);
    if (kind === "plug") camera.position.set(-1.8, 2.1, 4.5);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.minPolarAngle = Math.PI / 3;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minAzimuthAngle = -Math.PI / 2.5;
    controls.maxAzimuthAngle = Math.PI / 2.5;
    controls.update();
    const render = () => renderer.render(scene, camera);
    const resize = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!width || !height) return;
      const halfHeight = kind === "plug" ? 0.75 : kind === "solarbank" ? 0.63 : kind === "expansions" ? 0.48 : 0.8;
      const minWidth = kind === "plug" ? 0.62 : kind === "solarbank" ? 0.75 : kind === "expansions" ? Math.min(3, count) * 0.45 + 0.1 : 1.05;
      const halfWidth = Math.max(halfHeight * width / height, minWidth);
      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfWidth * height / width;
      camera.bottom = -camera.top;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      render();
    };
    refreshDisplay.current = () => {
      if (!displayCanvas || !displayTexture) return;
      const context = displayCanvas.getContext("2d")!;
      context.fillStyle = "#101515";
      context.fillRect(0, 0, 512, 128);
      context.fillStyle = "#effaf8";
      context.textAlign = "center";
      context.font = "64px monospace";
      const value = charge.current;
      context.fillText(value === undefined || !Number.isFinite(value) ? "--" : `${Math.round(Math.max(0, Math.min(100, value)))}%`, 256, 86);
      displayTexture.needsUpdate = true;
      render();
    };
    refreshDisplay.current();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      model.rotation.y = THREE.MathUtils.clamp(model.rotation.y + (event.key === "ArrowLeft" ? -0.12 : 0.12), -0.6, 0.6);
      render();
    };
    const lost = (event: Event) => { event.preventDefault(); setUnavailable(true); };
    renderer.domElement.addEventListener("webglcontextlost", lost);
    element.addEventListener("keydown", keyboard);
    controls.addEventListener("change", render);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => {
      refreshDisplay.current = null;
      observer.disconnect();
      element.removeEventListener("keydown", keyboard);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      controls.dispose();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
      key.shadow.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [kind, count]);

  useEffect(() => refreshDisplay.current?.(), [soc]);

  return <div className={`product-scene${kind === "expansions" ? " product-scene-small" : ""}`} ref={host} role="group" tabIndex={0} aria-label={kind === "plug" ? "Anker SOLIX plug 3D model" : kind === "solarbank" ? "Solarbank 3D model" : kind === "expansions" ? "Expansion batteries 3D model" : "Solar panels 3D model"} title="Rotate model">
    {unavailable && <span className="product-scene-fallback">{kind === "plug" ? "Anker SOLIX plug" : kind === "solarbank" ? "Anker SOLIX" : kind === "expansions" ? "Expansion batteries" : "Solar panels"}</span>}
  </div>;
}