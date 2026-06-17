import {
  CustomMapData,
  TerrainType,
  Position,
  MapValidationResult,
} from '../game/types';
import { GRID_SIZE, isInsideDish } from '../game/environment';
import { v4 as uuidv4 } from 'uuid';

const MAX_MAPS = 50;
const MIN_SPAWN_DISTANCE = 8;
const MAX_BARRIER_PERCENTAGE = 0.30;
const TOXIN_DAMAGE_PER_TURN = 2;
const THUMBNAIL_SIZE = 64;
const MAX_HISTORY = 50;

export { TOXIN_DAMAGE_PER_TURN };

export interface MapListItem {
  mapId: string;
  name: string;
  createdAt: number;
  spawnCount: number;
  thumbnail?: string;
  likeCount?: number;
  likedBy?: string[];
}

const TERRAIN_COLORS_HEX: Record<TerrainType, [number, number, number]> = {
  normal: [212, 196, 168],
  high_nutrient: [124, 179, 66],
  barren: [161, 136, 127],
  toxin: [142, 36, 170],
  barrier: [55, 71, 79],
};

export class MapManager {
  private maps: Map<string, CustomMapData> = new Map();
  private mapList: MapListItem[] = [];

  validateMap(mapData: Omit<CustomMapData, 'mapId' | 'createdAt'>): MapValidationResult {
    const errors: string[] = [];
    const { gridSize, terrain, spawnPoints } = mapData;

    if (gridSize !== GRID_SIZE) {
      errors.push(`地图大小必须是 ${GRID_SIZE}x${GRID_SIZE}`);
    }

    if (!terrain || terrain.length !== gridSize) {
      errors.push('地形数据格式错误');
    } else {
      for (let y = 0; y < gridSize; y++) {
        if (!terrain[y] || terrain[y].length !== gridSize) {
          errors.push(`第 ${y} 行地形数据长度错误`);
          break;
        }
      }
    }

    if (spawnPoints.length < 2) {
      errors.push('至少需要2个出生点');
    }
    if (spawnPoints.length > 6) {
      errors.push('最多只能有6个出生点');
    }

    for (let i = 0; i < spawnPoints.length; i++) {
      const sp = spawnPoints[i];
      if (sp.x < 0 || sp.x >= gridSize || sp.y < 0 || sp.y >= gridSize) {
        errors.push(`出生点 ${i + 1} 位置超出网格`);
        continue;
      }
      if (terrain[sp.y] && terrain[sp.y][sp.x] === 'barrier') {
        errors.push(`出生点 ${i + 1} 不能放置在屏障区上`);
      }
    }

    for (let i = 0; i < spawnPoints.length; i++) {
      for (let j = i + 1; j < spawnPoints.length; j++) {
        if (
          spawnPoints[i].x === spawnPoints[j].x &&
          spawnPoints[i].y === spawnPoints[j].y
        ) {
          errors.push(`出生点 ${i + 1} 和 ${j + 1} 重叠`);
        }
      }
    }

    for (let i = 0; i < spawnPoints.length; i++) {
      for (let j = i + 1; j < spawnPoints.length; j++) {
        const dist = this.bfsDistance(
          terrain,
          gridSize,
          spawnPoints[i],
          spawnPoints[j]
        );
        if (dist === -1) {
          errors.push(
            `出生点 ${i + 1} 和 ${j + 1} 之间不连通（被屏障阻断）`
          );
        } else if (dist < MIN_SPAWN_DISTANCE) {
          errors.push(
            `出生点 ${i + 1} 和 ${j + 1} 距离过近（最短路径 ${dist} 格，需 >= ${MIN_SPAWN_DISTANCE}）`
          );
        }
      }
    }

    let barrierCount = 0;
    let totalDishCells = 0;
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        if (!isInsideDish(x, y, gridSize)) continue;
        totalDishCells++;
        if (terrain[y] && terrain[y][x] === 'barrier') {
          barrierCount++;
        }
      }
    }

    if (totalDishCells > 0) {
      const barrierRatio = barrierCount / totalDishCells;
      if (barrierRatio > MAX_BARRIER_PERCENTAGE) {
        errors.push(
          `屏障区面积过大（${Math.round(barrierRatio * 100)}%，需 <= 30%）`
        );
      }
    }

    let hasHighNutrient = false;
    outer: for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        if (!isInsideDish(x, y, gridSize)) continue;
        if (terrain[y] && terrain[y][x] === 'high_nutrient') {
          hasHighNutrient = true;
          break outer;
        }
      }
    }
    if (!hasHighNutrient) {
      errors.push('至少需要1个高营养区');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private bfsDistance(
    terrain: TerrainType[][],
    gridSize: number,
    start: Position,
    end: Position
  ): number {
    if (start.x === end.x && start.y === end.y) return 0;

    const visited: boolean[][] = Array.from({ length: gridSize }, () =>
      Array(gridSize).fill(false)
    );
    const queue: Array<{ x: number; y: number; dist: number }> = [
      { x: start.x, y: start.y, dist: 0 },
    ];
    visited[start.y][start.x] = true;

    const dirs = [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const [dx, dy] of dirs) {
        const nx = curr.x + dx;
        const ny = curr.y + dy;
        if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
        if (visited[ny][nx]) continue;
        if (!isInsideDish(nx, ny, gridSize)) continue;
        if (terrain[ny] && terrain[ny][nx] === 'barrier') continue;

        if (nx === end.x && ny === end.y) {
          return curr.dist + 1;
        }

        visited[ny][nx] = true;
        queue.push({ x: nx, y: ny, dist: curr.dist + 1 });
      }
    }

    return -1;
  }

  saveMap(
    mapData: Omit<CustomMapData, 'mapId' | 'createdAt'>
  ): CustomMapData | null {
    const validation = this.validateMap(mapData);
    if (!validation.valid) return null;

    const mapId = 'map_' + uuidv4().slice(0, 8);
    const thumbnail = this.generateThumbnail(mapData.terrain, mapData.spawnPoints, mapData.gridSize);
    const fullMap: CustomMapData = {
      ...mapData,
      mapId,
      createdAt: Date.now(),
      thumbnail,
      likeCount: 0,
      likedBy: [],
    };

    this.maps.set(mapId, fullMap);
    this.mapList.unshift({
      mapId,
      name: fullMap.name,
      createdAt: fullMap.createdAt,
      spawnCount: fullMap.spawnPoints.length,
      thumbnail,
      likeCount: 0,
      likedBy: [],
    });

    if (this.mapList.length > MAX_MAPS) {
      const removed = this.mapList.pop()!;
      this.maps.delete(removed.mapId);
    }

    return fullMap;
  }

  likeMap(mapId: string, clientId: string): { likeCount: number; liked: boolean } | null {
    const map = this.maps.get(mapId);
    if (!map) return null;

    if (!map.likedBy) map.likedBy = [];
    if (!map.likeCount) map.likeCount = 0;

    let liked = false;
    if (map.likedBy.includes(clientId)) {
      map.likedBy = map.likedBy.filter((c) => c !== clientId);
      map.likeCount = Math.max(0, map.likeCount - 1);
    } else {
      map.likedBy.push(clientId);
      map.likeCount += 1;
      liked = true;
    }

    const listItem = this.mapList.find((m) => m.mapId === mapId);
    if (listItem) {
      listItem.likeCount = map.likeCount;
      listItem.likedBy = [...map.likedBy];
    }

    this.sortMapList();
    return { likeCount: map.likeCount, liked };
  }

  private sortMapList() {
    this.mapList.sort((a, b) => {
      const likeA = a.likeCount || 0;
      const likeB = b.likeCount || 0;
      if (likeB !== likeA) return likeB - likeA;
      return b.createdAt - a.createdAt;
    });
  }

  private generateThumbnail(
    terrain: TerrainType[][],
    spawnPoints: Position[],
    gridSize: number
  ): string {
    const cellSize = Math.max(1, Math.floor(THUMBNAIL_SIZE / gridSize));
    const actualSize = cellSize * gridSize;
    const pixels: number[] = [];

    for (let py = 0; py < THUMBNAIL_SIZE; py++) {
      for (let px = 0; px < THUMBNAIL_SIZE; px++) {
        if (px >= actualSize || py >= actualSize) {
          pixels.push(15, 25, 35, 255);
          continue;
        }
        const gx = Math.floor(px / cellSize);
        const gy = Math.floor(py / cellSize);
        const t = terrain[gy]?.[gx] || 'normal';
        const color = TERRAIN_COLORS_HEX[t];
        pixels.push(color[0], color[1], color[2], 255);
      }
    }

    for (const sp of spawnPoints) {
      const cx = sp.x * cellSize + Math.floor(cellSize / 2);
      const cy = sp.y * cellSize + Math.floor(cellSize / 2);
      const radius = Math.max(1, Math.floor(cellSize * 0.4));
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy <= radius * radius) {
            const px = cx + dx;
            const py = cy + dy;
            if (px >= 0 && px < THUMBNAIL_SIZE && py >= 0 && py < THUMBNAIL_SIZE) {
              const idx = (py * THUMBNAIL_SIZE + px) * 4;
              pixels[idx] = 255;
              pixels[idx + 1] = 255;
              pixels[idx + 2] = 255;
              pixels[idx + 3] = 255;
            }
          }
        }
      }
    }

    let binary = '';
    for (let i = 0; i < pixels.length; i++) {
      binary += String.fromCharCode(pixels[i]);
    }
    return Buffer.from(binary, 'binary').toString('base64');
  }

  getMap(mapId: string): CustomMapData | null {
    return this.maps.get(mapId) || null;
  }

  getMapList(): MapListItem[] {
    this.sortMapList();
    return [...this.mapList];
  }

  mapExists(mapId: string): boolean {
    return this.maps.has(mapId);
  }
}
