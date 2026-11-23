/**
 * Camera maths for drawing HTML labels over the 3D view and for the top-down minimap.
 * Kept free of any renderer type so it runs in Node tests.
 */

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Camera axes from a column-major world matrix (the three.js layout, which Aholo shares):
 * columns are right, up, backward and position.
 */
export function cameraBasis(elements) {
  return {
    right: [elements[0], elements[1], elements[2]],
    up: [elements[4], elements[5], elements[6]],
    forward: [-elements[8], -elements[9], -elements[10]],
    position: [elements[12], elements[13], elements[14]],
  };
}

/**
 * Project a world point into the view.
 * @param {number[]} point world position [x, y, z]
 * @param {{right:number[], up:number[], forward:number[], position:number[]}} basis from `cameraBasis`
 * @param {number} fov vertical field of view in degrees
 * @param {number} aspect width / height
 * @returns {{x: number, y: number, depth: number, visible: boolean}} x and y are 0..1 from the top-left
 *   corner; `depth` is the distance along the view direction; `visible` is false behind or outside the view.
 */
export function projectPoint(point, basis, fov, aspect, near = 0.05) {
  const offset = [point[0] - basis.position[0], point[1] - basis.position[1], point[2] - basis.position[2]];
  const depth = dot(offset, basis.forward);
  if (depth <= near) return { x: 0, y: 0, depth, visible: false };
  const half = Math.tan((fov * Math.PI) / 360);
  const x = dot(offset, basis.right) / (depth * half * aspect);
  const y = dot(offset, basis.up) / (depth * half);
  return { x: (x + 1) / 2, y: (1 - y) / 2, depth, visible: Math.abs(x) <= 1 && Math.abs(y) <= 1 };
}

/**
 * The world-space direction of the ray through a screen position (the inverse of `projectPoint`).
 * @param {number} x 0..1 from the left edge
 * @param {number} y 0..1 from the top edge
 * @returns {number[]} unit vector
 */
export function screenRay(basis, fov, aspect, x, y) {
  const half = Math.tan((fov * Math.PI) / 360);
  const sideways = (2 * x - 1) * half * aspect, upwards = (1 - 2 * y) * half;
  const direction = [0, 1, 2].map(axis => basis.forward[axis] + basis.right[axis] * sideways + basis.up[axis] * upwards);
  const length = Math.hypot(...direction);
  return direction.map(value => value / length);
}

/**
 * A fitted top-down map transform: walking-frame x/z (metres) <-> map pixels.
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number}} bounds walkable extent in metres
 * @param {number} width map width in pixels
 * @param {number} height map height in pixels
 * @param {number} [padding] pixels kept free around the plan
 */
export function mapTransform(bounds, width, height, padding = 12) {
  const spanX = Math.max(bounds.maxX - bounds.minX, 0.1), spanZ = Math.max(bounds.maxZ - bounds.minZ, 0.1);
  const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanZ);
  const offsetX = (width - spanX * scale) / 2, offsetY = (height - spanZ * scale) / 2;
  return {
    scale,
    toMap: (x, z) => [offsetX + (x - bounds.minX) * scale, offsetY + (z - bounds.minZ) * scale],
    toWorld: (px, py) => [bounds.minX + (px - offsetX) / scale, bounds.minZ + (py - offsetY) / scale],
  };
}

/** Bounds of a triangle mesh's x/z extent. */
export function boundsOf(positions) {
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < positions.length; i += 3) {
    bounds.minX = Math.min(bounds.minX, positions[i]); bounds.maxX = Math.max(bounds.maxX, positions[i]);
    bounds.minZ = Math.min(bounds.minZ, positions[i + 2]); bounds.maxZ = Math.max(bounds.maxZ, positions[i + 2]);
  }
  return bounds;
}
