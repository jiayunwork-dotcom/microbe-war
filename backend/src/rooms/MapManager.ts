import {
  CustomMapData,
  TerrainType,
  Position,
  MapValidationResult,
} from '../game/types.js';
import { GRID_SIZE, isInsideDish } from '../game/environment.js';
import { v4 as uuidv4 } from 'uuid';

const MAX_MAPS = 50;
const MIN_SPAWN_DISTANCE = 8;
const MAX_BARRIER_PERCENTAGE = 0.30;
const TOXIN_DAMAGE_PER_TURN = 2;

export { TOXIN_DAMAGE_PER_TURN };

export interface MapListItem {
  mapId: string;
  name: string;
  createdAt: number;
  spawnCount: number;
}

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
    const fullMap: CustomMapData = {
      ...mapData,
      mapId,
      createdAt: Date.now(),
    };

    this.maps.set(mapId, fullMap);
    this.mapList.unshift({
      mapId,
      name: fullMap.name,
      createdAt: fullMap.createdAt,
      spawnCount: fullMap.spawnPoints.length,
    });

    if (this.mapList.length > MAX_MAPS) {
      const removed = this.mapList.pop()!;
      this.maps.delete(removed.mapId);
    }

    return fullMap;
  }

  getMap(mapId: string): CustomMapData | null {
    return this.maps.get(mapId) || null;
  }

  getMapList(): MapListItem[] {
    return [...this.mapList];
  }

  mapExists(mapId: string): boolean {
    return this.maps.has(mapId);
  }
}
