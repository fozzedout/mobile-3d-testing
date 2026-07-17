import * as THREE from "three";
import { edgeTable as edgeTableRaw, triTable as triTableRaw } from "three/examples/jsm/objects/MarchingCubes.js";

// @types/three incorrectly types these as Int32Array[]; runtime exports are flat Int32Arrays.
const edgeTable = edgeTableRaw as unknown as Int32Array;
const triTable = triTableRaw as unknown as Int32Array;

/** Axis-aligned rounded box in world space (half-extents + corner radius). */
export interface HullBox {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  /** Corner roundness; larger = softer module. */
  radius: number;
}

function sdRoundBox(
  px: number, py: number, pz: number,
  hx: number, hy: number, hz: number,
  r: number,
): number {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const qz = Math.abs(pz) - hz + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  const outside = Math.hypot(ox, oy, oz);
  const inside = Math.min(Math.max(qx, qy, qz), 0);
  return outside + inside - r;
}

/** Polynomial smooth-min — k is the fillet / "sleekness" width. */
function smin(a: number, b: number, k: number): number {
  if (k <= 1e-6) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function sampleSdf(x: number, y: number, z: number, boxes: HullBox[], k: number): number {
  let d = Infinity;
  for (const b of boxes) {
    const bd = sdRoundBox(x - b.cx, y - b.cy, z - b.cz, b.hx, b.hy, b.hz, b.radius);
    d = smin(d, bd, k);
  }
  return d;
}

// Cube corner offsets and edge endpoint indices (Paul Bourke / Cory Bloyd).
const CORNER: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const EDGE_VERT: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Polygonize a smooth-union of rounded boxes via marching cubes.
 * Returns a non-indexed BufferGeometry with computed normals, or null if empty.
 */
export function buildSdfHullGeometry(
  boxes: HullBox[],
  opts?: { smoothK?: number; samplesPerCell?: number; cellSize?: number; pad?: number },
): THREE.BufferGeometry | null {
  if (boxes.length === 0) return null;

  const smoothK = opts?.smoothK ?? 1.1;
  const samplesPerCell = opts?.samplesPerCell ?? 3;
  const cellSize = opts?.cellSize ?? 4;
  const pad = opts?.pad ?? cellSize * 1.25;
  const step = cellSize / samplesPerCell;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.cx - b.hx - b.radius);
    maxX = Math.max(maxX, b.cx + b.hx + b.radius);
    minY = Math.min(minY, b.cy - b.hy - b.radius);
    maxY = Math.max(maxY, b.cy + b.hy + b.radius);
    minZ = Math.min(minZ, b.cz - b.hz - b.radius);
    maxZ = Math.max(maxZ, b.cz + b.hz + b.radius);
  }
  minX -= pad; maxX += pad;
  minY -= pad; maxY += pad;
  minZ -= pad; maxZ += pad;

  const nx = Math.max(2, Math.ceil((maxX - minX) / step));
  const ny = Math.max(2, Math.ceil((maxY - minY) / step));
  const nz = Math.max(2, Math.ceil((maxZ - minZ) / step));
  // Cap grid so a huge layout can't melt a phone — ~48³ is plenty for editor ships.
  const maxDim = 48;
  const scale = Math.max(nx, ny, nz) > maxDim ? maxDim / Math.max(nx, ny, nz) : 1;
  const rx = Math.max(2, Math.round(nx * scale));
  const ry = Math.max(2, Math.round(ny * scale));
  const rz = Math.max(2, Math.round(nz * scale));
  const dx = (maxX - minX) / rx;
  const dy = (maxY - minY) / ry;
  const dz = (maxZ - minZ) / rz;

  const field = new Float32Array((rx + 1) * (ry + 1) * (rz + 1));
  const idx = (i: number, j: number, k: number): number => i + j * (rx + 1) + k * (rx + 1) * (ry + 1);
  for (let k = 0; k <= rz; k++) {
    const z = minZ + k * dz;
    for (let j = 0; j <= ry; j++) {
      const y = minY + j * dy;
      for (let i = 0; i <= rx; i++) {
        field[idx(i, j, k)] = sampleSdf(minX + i * dx, y, z, boxes, smoothK);
      }
    }
  }

  const positions: number[] = [];
  const vertCache = new Map<string, number>();
  const edgeKey = (i: number, j: number, k: number, e: number): string => `${i},${j},${k},${e}`;

  const cornerVal = (i: number, j: number, k: number, c: number): number => {
    const [ci, cj, ck] = CORNER[c];
    return field[idx(i + ci, j + cj, k + ck)];
  };
  const cornerPos = (i: number, j: number, k: number, c: number): [number, number, number] => {
    const [ci, cj, ck] = CORNER[c];
    return [minX + (i + ci) * dx, minY + (j + cj) * dy, minZ + (k + ck) * dz];
  };

  const lerpVert = (i: number, j: number, k: number, e: number): number => {
    const key = edgeKey(i, j, k, e);
    const cached = vertCache.get(key);
    if (cached !== undefined) return cached;
    const [a, b] = EDGE_VERT[e];
    const va = cornerVal(i, j, k, a);
    const vb = cornerVal(i, j, k, b);
    const [ax, ay, az] = cornerPos(i, j, k, a);
    const [bx, by, bz] = cornerPos(i, j, k, b);
    const t = Math.abs(va - vb) < 1e-8 ? 0 : va / (va - vb);
    const vi = positions.length / 3;
    positions.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
    vertCache.set(key, vi);
    return vi;
  };

  const indices: number[] = [];
  for (let k = 0; k < rz; k++) {
    for (let j = 0; j < ry; j++) {
      for (let i = 0; i < rx; i++) {
        let cubeindex = 0;
        for (let c = 0; c < 8; c++) {
          if (cornerVal(i, j, k, c) < 0) cubeindex |= 1 << c;
        }
        const edges = edgeTable[cubeindex];
        if (edges === 0) continue;

        const verts: number[] = new Array(12);
        for (let e = 0; e < 12; e++) {
          if (edges & (1 << e)) verts[e] = lerpVert(i, j, k, e);
        }

        // triTable is packed 16 entries per cube configuration (same as Three's export).
        const base = cubeindex << 4;
        for (let t = 0; triTable[base + t] !== -1; t += 3) {
          const a = verts[triTable[base + t]];
          const b = verts[triTable[base + t + 1]];
          const c = verts[triTable[base + t + 2]];
          // SDF negative = inside; Bourke winding faces outward for that convention.
          indices.push(a, b, c);
        }
      }
    }
  }

  if (indices.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
