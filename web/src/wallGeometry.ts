import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export interface WallOpening { x: number; bottom: number; width: number; height: number }

export function wallGeometry(width: number, height: number, depth: number, openings: WallOpening[]) {
  const horizontal = [...new Set([-width / 2, width / 2, ...openings.flatMap((opening) => [opening.x - opening.width / 2, opening.x + opening.width / 2])])].sort((left, right) => left - right);
  const vertical = [...new Set([0, height, ...openings.flatMap((opening) => [opening.bottom, opening.bottom + opening.height])])].sort((left, right) => left - right);
  const pieces: THREE.BufferGeometry[] = [];
  for (let column = 0; column < horizontal.length - 1; column++) {
    for (let row = 0; row < vertical.length - 1; row++) {
      const left = horizontal[column]!;
      const right = horizontal[column + 1]!;
      const bottom = vertical[row]!;
      const top = vertical[row + 1]!;
      const centerX = (left + right) / 2;
      const centerY = (bottom + top) / 2;
      if (openings.some((opening) => centerX > opening.x - opening.width / 2 && centerX < opening.x + opening.width / 2 && centerY > opening.bottom && centerY < opening.bottom + opening.height)) continue;
      const piece = new THREE.BoxGeometry(right - left, top - bottom, depth);
      piece.translate(centerX, centerY, -depth / 2);
      pieces.push(piece);
    }
  }
  const geometry = mergeGeometries(pieces)!;
  pieces.forEach((piece) => piece.dispose());
  return geometry;
}