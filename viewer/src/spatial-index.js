/**
 * Spatial index over a venue's places, in the walking frame (metres, x/z on the floor, one index per level).
 *
 * Points and zone polygons are bucketed into a uniform grid: a lookup touches only the cells around the
 * query, so "which zone am I standing in" and "what is near me" stay constant-time however many places a
 * building has. A grid suits indoor data (bounded extent, evenly spread places) and needs no rebalancing
 * when a place is added while tagging.
 */

const key = (level, cx, cz) => `${level}|${cx}|${cz}`;

/** Even-odd ray cast: is (x, z) inside the polygon [[x, z], ...]? Points on an edge count as inside. */
export function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
    const cross = (x - xi) * (zj - zi) - (z - zi) * (xj - xi);
    if (Math.abs(cross) < 1e-12 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && z >= Math.min(zi, zj) && z <= Math.max(zi, zj)) return true;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed area of [[x, z], ...] (positive when counter-clockwise in x/z). */
export function polygonArea(polygon) {
  let twice = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) twice += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
  return twice / 2;
}

export class SpatialIndex {
  /** @param {{cellSize?: number}} [options] grid cell edge in metres; 2 m suits rooms and corridors */
  constructor({ cellSize = 2 } = {}) {
    this.cellSize = cellSize;
    this.pointCells = new Map();
    this.zoneCells = new Map();
    this.points = new Map();
    this.zones = new Map();
    this.pointsOnLevel = new Map();
  }

  cell(value) { return Math.floor(value / this.cellSize); }

  /** Index a point place. `item` is returned by queries. */
  insertPoint(id, x, z, level, item = { id }) {
    this.remove(id);
    const cellKey = key(level, this.cell(x), this.cell(z));
    const entry = { id, x, z, level, item, cellKey };
    (this.pointCells.get(cellKey) ?? this.pointCells.set(cellKey, []).get(cellKey)).push(entry);
    this.points.set(id, entry);
    this.pointsOnLevel.set(level, (this.pointsOnLevel.get(level) ?? 0) + 1);
  }

  /** Index a zone by its floor polygon [[x, z], ...]. */
  insertZone(id, polygon, level, item = { id }) {
    this.remove(id);
    const xs = polygon.map(point => point[0]), zs = polygon.map(point => point[1]);
    const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    const entry = { id, polygon, level, item, box, area: Math.abs(polygonArea(polygon)), cellKeys: [] };
    for (let cx = this.cell(box.minX); cx <= this.cell(box.maxX); cx++) {
      for (let cz = this.cell(box.minZ); cz <= this.cell(box.maxZ); cz++) {
        const cellKey = key(level, cx, cz);
        entry.cellKeys.push(cellKey);
        (this.zoneCells.get(cellKey) ?? this.zoneCells.set(cellKey, []).get(cellKey)).push(entry);
      }
    }
    this.zones.set(id, entry);
  }

  remove(id) {
    const point = this.points.get(id);
    if (point) {
      const bucket = this.pointCells.get(point.cellKey);
      bucket.splice(bucket.indexOf(point), 1);
      if (!bucket.length) this.pointCells.delete(point.cellKey);
      this.points.delete(id);
      this.pointsOnLevel.set(point.level, this.pointsOnLevel.get(point.level) - 1);
    }
    const zone = this.zones.get(id);
    if (zone) {
      for (const cellKey of zone.cellKeys) {
        const bucket = this.zoneCells.get(cellKey);
        bucket.splice(bucket.indexOf(zone), 1);
        if (!bucket.length) this.zoneCells.delete(cellKey);
      }
      this.zones.delete(id);
    }
  }

  /** The zone containing (x, z) on a level; the smallest one when zones nest (a desk area inside a room). */
  zoneAt(x, z, level) {
    let best = null;
    for (const zone of this.zoneCells.get(key(level, this.cell(x), this.cell(z))) ?? []) {
      const { box } = zone;
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (pointInPolygon(x, z, zone.polygon) && (!best || zone.area < best.area)) best = zone;
    }
    return best?.item ?? null;
  }

  /**
   * The `count` point places nearest to (x, z) by straight-line distance, nearest first.
   * Searches ring by ring outwards and stops once no unvisited cell can hold a closer place.
   * @returns {Array<{item: object, distance: number}>}
   */
  nearest(x, z, level, { count = 1, maxDistance = Infinity, filter } = {}) {
    const found = [];
    const cx = this.cell(x), cz = this.cell(z);
    const levelPoints = this.pointsOnLevel.get(level) ?? 0;
    if (!levelPoints) return found;
    const maxRing = Number.isFinite(maxDistance) ? Math.ceil(maxDistance / this.cellSize) + 1 : Infinity;
    let visited = 0;
    for (let ring = 0; ring <= maxRing && visited < levelPoints; ring++) {
      // Every place in rings beyond this one is at least (ring - 1) cells away.
      if (found.length >= count && found[count - 1].distance <= (ring - 1) * this.cellSize) break;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          for (const point of this.pointCells.get(key(level, cx + dx, cz + dz)) ?? []) {
            visited++;
            const distance = Math.hypot(point.x - x, point.z - z);
            if (distance > maxDistance || (filter && !filter(point.item))) continue;
            found.push({ item: point.item, distance });
          }
        }
      }
      found.sort((a, b) => a.distance - b.distance);
    }
    return found.slice(0, count);
  }

  /** Every point place within `radius` metres of (x, z), nearest first. */
  within(x, z, level, radius) {
    return this.nearest(x, z, level, { count: Infinity, maxDistance: radius });
  }
}
