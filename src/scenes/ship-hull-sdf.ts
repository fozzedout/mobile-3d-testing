import * as THREE from "three";
import { edgeTable as edgeTableRaw, triTable as triTableRaw } from "three/examples/jsm/objects/MarchingCubes.js";

// @types/three incorrectly types these as Int32Array[]; runtime exports are flat Int32Arrays.
const edgeTable = edgeTableRaw as unknown as Int32Array;
const triTable = triTableRaw as unknown as Int32Array;

/** Structure / module SDF primitives. Optional quaternion orients local → world. */
export type HullPrimitive = {
  kind: "box" | "cone" | "wedge" | "dome" | "semi";
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  /** Box corner roundness (box only). */
  radius?: number;
  /** Unit quaternion (local → world). Identity if omitted. */
  qx?: number;
  qy?: number;
  qz?: number;
  qw?: number;
};

function sdRoundBox(
  px: number, py: number, pz: number,
  hx: number, hy: number, hz: number,
  r: number,
): number {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const qz = Math.abs(pz) - hz + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  const inside = Math.min(Math.max(qx, qy, qz), 0);
  return outside + inside - r;
}

function sdEllipsoid(px: number, py: number, pz: number, hx: number, hy: number, hz: number): number {
  const k0 = Math.hypot(px / hx, py / hy, pz / hz);
  const k1 = Math.hypot(px / (hx * hx), py / (hy * hy), pz / (hz * hz));
  return k0 === 0 ? Math.min(hx, hy, hz) * -1 : k0 * (k0 - 1) / k1;
}

/** Cone tip at y=+hy, elliptical base radii (hx,hz) at y=-hy — matches THREE.ConeGeometry. */
function sdCone(px: number, py: number, pz: number, hx: number, hy: number, hz: number): number {
  const t = (hy - py) / Math.max(2 * hy, 1e-6); // 0 at tip, 1 at base
  if (t <= 0) return Math.hypot(px, pz, py - hy); // beyond tip
  const rx = Math.max(1e-4, hx * Math.min(t, 1));
  const rz = Math.max(1e-4, hz * Math.min(t, 1));
  const radial = Math.hypot(px / rx, pz / rz) - 1;
  if (t > 1) {
    const outside = Math.hypot(Math.max(radial, 0) * Math.min(rx, rz), -hy - py);
    return radial > 0 ? outside : -hy - py;
  }
  return radial * Math.min(rx, rz);
}

/** Triangular prism: base on y=-hy, ridge along z at y=+hy, x=0. */
function sdWedge(px: number, py: number, pz: number, hx: number, hy: number, hz: number): number {
  const dTri = sdTrianglePrismXY(px, py, hx, hy);
  const dZ = Math.abs(pz) - hz;
  return Math.min(Math.max(dTri, dZ), 0) + Math.hypot(Math.max(dTri, 0), Math.max(dZ, 0));
}

function sdTrianglePrismXY(px: number, py: number, hx: number, hy: number): number {
  // Equilateral-ish isosceles triangle: (-hx,-hy), (hx,-hy), (0,hy)
  const p1x = -hx, p1y = -hy;
  const p2x = hx, p2y = -hy;
  const p3x = 0, p3y = hy;
  const e0x = p2x - p1x, e0y = p2y - p1y;
  const e1x = p3x - p2x, e1y = p3y - p2y;
  const e2x = p1x - p3x, e2y = p1y - p3y;
  const v0x = px - p1x, v0y = py - p1y;
  const v1x = px - p2x, v1y = py - p2y;
  const v2x = px - p3x, v2y = py - p3y;
  const dot00 = e0x * e0x + e0y * e0y;
  const dot01 = e0x * v0x + e0y * v0y;
  const dot11 = e1x * e1x + e1y * e1y;
  const dot12 = e1x * v1x + e1y * v1y;
  const dot22 = e2x * e2x + e2y * e2y;
  const dot20 = e2x * v2x + e2y * v2y;
  const pq0x = v0x - e0x * Math.min(Math.max(dot01 / dot00, 0), 1);
  const pq0y = v0y - e0y * Math.min(Math.max(dot01 / dot00, 0), 1);
  const pq1x = v1x - e1x * Math.min(Math.max(dot12 / dot11, 0), 1);
  const pq1y = v1y - e1y * Math.min(Math.max(dot12 / dot11, 0), 1);
  const pq2x = v2x - e2x * Math.min(Math.max(dot20 / dot22, 0), 1);
  const pq2y = v2y - e2y * Math.min(Math.max(dot20 / dot22, 0), 1);
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d = Math.min(
    pq0x * pq0x + pq0y * pq0y,
    pq1x * pq1x + pq1y * pq1y,
    pq2x * pq2x + pq2y * pq2y,
  );
  const s0 = s * (v0x * e0y - v0y * e0x);
  const s1 = s * (v1x * e1y - v1y * e1x);
  const s2 = s * (v2x * e2y - v2y * e2x);
  return -Math.sqrt(d) * Math.sign(Math.min(s0, s1, s2));
}

function sdSemiDome(px: number, py: number, pz: number, hx: number, hy: number, hz: number): number {
  // Half-ellipsoid above y=0 in local space (flat cut on the bottom).
  const dEll = sdEllipsoid(px, py, pz, hx, hy, hz);
  const dCut = -py; // outside below y=0
  // Intersection: max(ellipsoid, half-space y>=0) but ellipsoid centered at origin —
  // shift so flat sits on y=-hy bottom of AABB: use center at y=0 with only +Y half,
  // extents hy upward. Caller centers primitive so flat is at bottom of cell.
  return Math.max(dEll, dCut);
}

function quatConjugateApply(
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number, qw: number,
): [number, number, number] {
  // Apply q* (conjugate) to vector — world → local for unit quaternions.
  const ix = -qx, iy = -qy, iz = -qz, iw = qw;
  const tx = 2 * (iy * pz - iz * py);
  const ty = 2 * (iz * px - ix * pz);
  const tz = 2 * (ix * py - iy * px);
  return [
    px + iw * tx + (iy * tz - iz * ty),
    py + iw * ty + (iz * tx - ix * tz),
    pz + iw * tz + (ix * ty - iy * tx),
  ];
}

function quatApply(
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number, qw: number,
): [number, number, number] {
  const tx = 2 * (qy * pz - qz * py);
  const ty = 2 * (qz * px - qx * pz);
  const tz = 2 * (qx * py - qy * px);
  return [
    px + qw * tx + (qy * tz - qz * ty),
    py + qw * ty + (qz * tx - qx * tz),
    pz + qw * tz + (qx * ty - qy * tx),
  ];
}

function evalPrimitive(x: number, y: number, z: number, p: HullPrimitive): number {
  let px = x - p.cx;
  let py = y - p.cy;
  let pz = z - p.cz;
  const qw = p.qw ?? 1;
  const qx = p.qx ?? 0;
  const qy = p.qy ?? 0;
  const qz = p.qz ?? 0;
  if (qx !== 0 || qy !== 0 || qz !== 0 || qw !== 1) {
    [px, py, pz] = quatConjugateApply(px, py, pz, qx, qy, qz, qw);
  }
  switch (p.kind) {
    case "box":
      return sdRoundBox(px, py, pz, p.hx, p.hy, p.hz, p.radius ?? 0);
    case "cone":
      return sdCone(px, py, pz, p.hx, p.hy, p.hz);
    case "wedge":
      return sdWedge(px, py, pz, p.hx, p.hy, p.hz);
    case "dome":
      return sdEllipsoid(px, py, pz, p.hx, p.hy, p.hz);
    case "semi":
      return sdSemiDome(px, py, pz, p.hx, p.hy, p.hz);
  }
}

function primitiveBounds(p: HullPrimitive): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  const pad = p.kind === "box" ? (p.radius ?? 0) : 0;
  const qw = p.qw ?? 1;
  const qx = p.qx ?? 0;
  const qy = p.qy ?? 0;
  const qz = p.qz ?? 0;
  const oriented = qx !== 0 || qy !== 0 || qz !== 0 || qw !== 1;
  if (!oriented) {
    return {
      minX: p.cx - p.hx - pad,
      maxX: p.cx + p.hx + pad,
      minY: p.cy - p.hy - pad,
      maxY: p.cy + p.hy + pad,
      minZ: p.cz - p.hz - pad,
      maxZ: p.cz + p.hz + pad,
    };
  }
  // Oriented AABB from the 8 local corners.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const [wx, wy, wz] = quatApply(sx * (p.hx + pad), sy * (p.hy + pad), sz * (p.hz + pad), qx, qy, qz, qw);
        minX = Math.min(minX, p.cx + wx); maxX = Math.max(maxX, p.cx + wx);
        minY = Math.min(minY, p.cy + wy); maxY = Math.max(maxY, p.cy + wy);
        minZ = Math.min(minZ, p.cz + wz); maxZ = Math.max(maxZ, p.cz + wz);
      }
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/** Polynomial smooth-min — k is the fillet / "sleekness" width. */
function smin(a: number, b: number, k: number): number {
  if (k <= 1e-6) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function sampleSdf(x: number, y: number, z: number, prims: HullPrimitive[], k: number): number {
  let d = Infinity;
  for (const p of prims) d = smin(d, evalPrimitive(x, y, z, p), k);
  return d;
}

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
 * Polygonize a smooth-union of hull primitives via marching cubes.
 * Returns BufferGeometry with computed normals, or null if empty.
 */
export function buildSdfHullGeometry(
  prims: HullPrimitive[],
  opts?: { smoothK?: number; samplesPerCell?: number; cellSize?: number; pad?: number },
): THREE.BufferGeometry | null {
  if (prims.length === 0) return null;

  const smoothK = opts?.smoothK ?? 1.1;
  const samplesPerCell = opts?.samplesPerCell ?? 3;
  const cellSize = opts?.cellSize ?? 4;
  const pad = opts?.pad ?? cellSize * 1.25;
  const step = cellSize / samplesPerCell;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of prims) {
    const b = primitiveBounds(p);
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
    minZ = Math.min(minZ, b.minZ); maxZ = Math.max(maxZ, b.maxZ);
  }
  minX -= pad; maxX += pad;
  minY -= pad; maxY += pad;
  minZ -= pad; maxZ += pad;

  const nx = Math.max(2, Math.ceil((maxX - minX) / step));
  const ny = Math.max(2, Math.ceil((maxY - minY) / step));
  const nz = Math.max(2, Math.ceil((maxZ - minZ) / step));
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
        field[idx(i, j, k)] = sampleSdf(minX + i * dx, y, z, prims, smoothK);
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

        const base = cubeindex << 4;
        for (let t = 0; triTable[base + t] !== -1; t += 3) {
          const a = verts[triTable[base + t]];
          const b = verts[triTable[base + t + 1]];
          const c = verts[triTable[base + t + 2]];
          indices.push(a, c, b);
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

/** @deprecated Use HullPrimitive. */
export type HullBox = HullPrimitive;
