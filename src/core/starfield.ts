import * as THREE from "three";

/** A static point-cloud shell, used as a depth/motion reference in open space scenes. */
export function buildStarfield(innerRadius: number, outerRadius: number, count = 4000): THREE.Points {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = THREE.MathUtils.lerp(innerRadius, outerRadius, Math.random());
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: true });
  return new THREE.Points(geometry, material);
}
