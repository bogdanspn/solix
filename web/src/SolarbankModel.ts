import * as THREE from "three";

export function createSolarbank({ stackable = false, color = 0x929594, edgeColor = 0x555958 }: { stackable?: boolean; color?: number; edgeColor?: number } = {}) {
  const group = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.48 });
  const edge = new THREE.MeshStandardMaterial({ color: edgeColor, roughness: 0.58, metalness: 0.35 });
  const black = new THREE.MeshStandardMaterial({ color: 0x101515, roughness: 0.23, metalness: 0.25 });
  const light = new THREE.MeshBasicMaterial({ color: 0x00bad4, transparent: true, opacity: 1 });
  const box = (width: number, height: number, depth: number, x: number, y: number, z: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const face = (points: number[][], depth: number, material: THREE.Material) => {
    const shape = new THREE.Shape();
    points.forEach(([x, y], index) => index === 0 ? shape.moveTo(x!, y!) : shape.lineTo(x!, y!));
    shape.closePath();
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
    mesh.position.z = depth;
    group.add(mesh);
  };
  const outline = new THREE.Shape();
  outline.moveTo(stackable ? -0.5 : -0.48, stackable ? 0.012 : 0.02);
  outline.lineTo(stackable ? 0.5 : 0.48, stackable ? 0.012 : 0.02);
  outline.lineTo(0.5, 0.77);
  outline.lineTo(0.47, 0.82);
  outline.lineTo(-0.47, 0.82);
  outline.lineTo(-0.5, 0.77);
  outline.closePath();
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(outline, {
    depth: 0.38, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 1, steps: 1,
  }), metal);
  body.position.z = -0.18;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  box(0.92, 0.77, 0.085, 0, 0.41, -0.225, black);
  for (let index = 0; index < 17; index++) {
    box(0.018, 0.8, 0.1, (index - 8) * 0.052, 0.425, -0.24, edge);
  }
  face([[-0.476, 0.775], [0.476, 0.775], [0.395, 0.58], [-0.395, 0.58]], 0.214, black);
  face([[-0.485, 0.76], [-0.397, 0.575], [-0.475, 0.04]], 0.214, edge);
  face([[0.485, 0.76], [0.475, 0.04], [0.397, 0.575]], 0.214, metal);
  box(0.65, 0.005, 0.004, 0, 0.608, 0.218, light);
  box(0.14, 0.013, 0.004, 0, 0.69, 0.218, light);
  if (!stackable) {
    for (const x of [-0.36, 0.36]) box(0.13, 0.025, 0.34, x, 0.005, -0.01, black);
  }
  return { group, light, body };
}