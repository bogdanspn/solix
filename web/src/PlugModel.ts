import * as THREE from "three";

export function createPlug() {
  const group = new THREE.Group();
  const casing = new THREE.MeshStandardMaterial({ color: 0x303332, roughness: 0.55, metalness: 0.12 });
  const recess = new THREE.MeshStandardMaterial({ color: 0x121514, roughness: 0.65 });
  const badge = new THREE.MeshStandardMaterial({ color: 0x0e1110, roughness: 0.3 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xc2c5c4, metalness: 0.65, roughness: 0.24 });
  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const outline = new THREE.Shape();
  outline.moveTo(-0.32, -0.4);
  outline.lineTo(0.32, -0.4);
  outline.quadraticCurveTo(0.4, -0.4, 0.4, -0.32);
  outline.lineTo(0.4, 0.32);
  outline.quadraticCurveTo(0.4, 0.4, 0.32, 0.4);
  outline.lineTo(-0.32, 0.4);
  outline.quadraticCurveTo(-0.4, 0.4, -0.4, 0.32);
  outline.lineTo(-0.4, -0.32);
  outline.quadraticCurveTo(-0.4, -0.4, -0.32, -0.4);
  const opening = new THREE.Path();
  opening.absarc(0, 0, 0.305, 0, Math.PI * 2, true);
  outline.holes.push(opening);
  const body = add("Plug casing", new THREE.ExtrudeGeometry(outline, {
    depth: 0.62, bevelEnabled: true, bevelSize: 0.009, bevelThickness: 0.009, bevelSegments: 3, curveSegments: 32,
  }), casing, 0, 0.46, 0);
  body.rotation.x = -Math.PI / 2;
  add("Socket well", new THREE.CylinderGeometry(0.303, 0.303, 0.025, 48), recess, 0, 0.76, 0);
  const lining = add("Socket lining", new THREE.CylinderGeometry(0.302, 0.302, 0.30, 48, 1, true), recess, 0, 0.922, 0);
  lining.material = recess.clone();
  lining.material.side = THREE.DoubleSide;
  for (const side of [-1, 1]) {
    add("Socket pin opening", new THREE.CylinderGeometry(0.037, 0.037, 0.006, 20), badge, side * 0.115, 0.775, 0);
    add("Earth contact", new THREE.BoxGeometry(0.035, 0.14, 0.065), metal, side * 0.278, 0.975, 0);
    add("Plug pin", new THREE.CapsuleGeometry(0.029, 0.19, 6, 16), metal, side * 0.15, 0.13, 0);
  }
  add("Plug base", new THREE.CylinderGeometry(0.275, 0.275, 0.24, 40), casing, 0, 0.34, 0);
  add("Front badge", new THREE.BoxGeometry(0.59, 0.22, 0.012), badge, 0, 0.93, 0.405);
  return group;
}