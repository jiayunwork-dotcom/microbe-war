import {
  TerrainType,
  SymmetryMode,
  BrushSize,
  EditMode,
  Position,
  CustomMapData,
  MapListItem,
  MapValidationResult,
} from './types.js';
import { GameWebSocket } from './network.js';

const GRID_SIZE = 30;
const CANVAS_SIZE = 600;
const CELL_SIZE = CANVAS_SIZE / GRID_SIZE;

const TERRAIN_COLORS: Record<TerrainType, string> = {
  normal: '#d4c4a8',
  high_nutrient: '#7cb342',
  barren: '#a1887f',
  toxin: '#8e24aa',
  barrier: '#37474f',
};

const SPAWN_COLORS = [
  '#ef5350',
  '#42a5f5',
  '#66bb6a',
  '#ffa726',
  '#ab47bc',
  '#26c6da',
];

export class MapEditor {
  private network: GameWebSocket;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private terrain: TerrainType[][];
  private spawnPoints: Position[];

  private currentTerrain: TerrainType = 'normal';
  private brushSize: BrushSize = 1;
  private symmetryMode: SymmetryMode = 'none';
  private editMode: EditMode = 'terrain';

  private isDrawing: boolean = false;
  private lastDrawnCells: Set<string> = new Set();

  constructor(canvas: HTMLCanvasElement, network: GameWebSocket) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.network = network;

    this.terrain = this.createEmptyTerrain();
    this.spawnPoints = [];

    this.setupCanvasListeners();
  }

  private createEmptyTerrain(): TerrainType[][] {
    const grid: TerrainType[][] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      const row: TerrainType[] = [];
      for (let x = 0; x < GRID_SIZE; x++) {
        row.push('normal');
      }
      grid.push(row);
    }
    return grid;
  }

  private setupCanvasListeners() {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this.onMouseUp());
    this.canvas.addEventListener('mouseleave', () => this.onMouseUp());
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onMouseDown(e: MouseEvent) {
    const { x, y } = this.getGridCoords(e);
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;

    if (this.editMode === 'terrain') {
      this.isDrawing = true;
      this.lastDrawnCells.clear();
      this.applyBrushAt(x, y);
    } else if (this.editMode === 'spawn') {
      this.handleSpawnClick(x, y, e.button === 2);
    }
    this.render();
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.isDrawing || this.editMode !== 'terrain') return;
    const { x, y } = this.getGridCoords(e);
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;
    this.applyBrushAt(x, y);
    this.render();
  }

  private onMouseUp() {
    this.isDrawing = false;
    this.lastDrawnCells.clear();
  }

  private getGridCoords(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    return {
      x: Math.floor(px / CELL_SIZE),
      y: Math.floor(py / CELL_SIZE),
    };
  }

  private applyBrushAt(cx: number, cy: number) {
    const half = Math.floor(this.brushSize / 2);
    const coords: Array<{ x: number; y: number }> = [];

    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
        coords.push({ x, y });
      }
    }

    const symmetricCoords = this.applySymmetry(coords);
    for (const { x, y } of symmetricCoords) {
      const key = `${x},${y}`;
      if (this.lastDrawnCells.has(key)) continue;
      this.lastDrawnCells.add(key);
      if (this.editMode === 'terrain') {
        this.terrain[y][x] = this.currentTerrain;
        if (this.currentTerrain === 'barrier') {
          this.spawnPoints = this.spawnPoints.filter(
            (p) => !(p.x === x && p.y === y)
          );
        }
      }
    }
    this.updateSpawnCountUI();
    this.checkSpawnWarnings();
  }

  private applySymmetry(
    coords: Array<{ x: number; y: number }>
  ): Array<{ x: number; y: number }> {
    const result = [...coords];
    const center = (GRID_SIZE - 1) / 2;

    if (this.symmetryMode === 'horizontal' || this.symmetryMode === 'four_way') {
      for (const { x, y } of coords) {
        const sx = Math.round(2 * center - x);
        result.push({ x: sx, y });
      }
    }
    if (this.symmetryMode === 'vertical' || this.symmetryMode === 'four_way') {
      for (const { x, y } of coords) {
        const sy = Math.round(2 * center - y);
        result.push({ x, y: sy });
      }
    }
    if (this.symmetryMode === 'four_way') {
      for (const { x, y } of coords) {
        const sx = Math.round(2 * center - x);
        const sy = Math.round(2 * center - y);
        result.push({ x: sx, y: sy });
      }
    }

    const seen = new Set<string>();
    return result.filter(({ x, y }) => {
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return false;
      const k = `${x},${y}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  private handleSpawnClick(x: number, y: number, isRightClick: boolean) {
    if (isRightClick) {
      this.spawnPoints = this.spawnPoints.filter(
        (p) => !(p.x === x && p.y === y)
      );
      this.updateSpawnCountUI();
      this.checkSpawnWarnings();
      return;
    }

    if (this.terrain[y][x] === 'barrier') {
      this.showWarning('出生点不能放在屏障区上！');
      return;
    }

    if (this.spawnPoints.some((p) => p.x === x && p.y === y)) {
      this.spawnPoints = this.spawnPoints.filter(
        (p) => !(p.x === x && p.y === y)
      );
      this.updateSpawnCountUI();
      this.checkSpawnWarnings();
      return;
    }

    if (this.spawnPoints.length >= 6) {
      this.showWarning('最多只能放置6个出生点！');
      return;
    }

    this.spawnPoints.push({ x, y });
    this.updateSpawnCountUI();
    this.checkSpawnWarnings();
  }

  private showWarning(message: string) {
    const warn = document.getElementById('spawn-warning');
    if (warn) {
      warn.style.display = 'block';
      warn.textContent = message;
      setTimeout(() => {
        warn.style.display = 'none';
      }, 3000);
    }
  }

  private checkSpawnWarnings() {
    const warnEl = document.getElementById('spawn-warning');
    if (!warnEl) return;

    const errors: string[] = [];

    for (const p of this.spawnPoints) {
      if (this.terrain[p.y][p.x] === 'barrier') {
        errors.push(`出生点(${p.x},${p.y})位于屏障区！`);
      }
    }

    for (let i = 0; i < this.spawnPoints.length; i++) {
      for (let j = i + 1; j < this.spawnPoints.length; j++) {
        const dist = this.bfsDistance(
          this.spawnPoints[i],
          this.spawnPoints[j]
        );
        if (dist >= 0 && dist < 8) {
          errors.push(
            `出生点${i + 1}和${j + 1}之间最短距离${dist}格，需≥8格`
          );
        } else if (dist < 0) {
          errors.push(`出生点${i + 1}和${j + 1}之间不连通`);
        }
      }
    }

    if (errors.length > 0 && warnEl.style.display === 'none') {
      warnEl.style.display = 'block';
      warnEl.innerHTML = errors.map((e) => `⚠️ ${e}`).join('<br>');
    } else if (errors.length === 0) {
      warnEl.style.display = 'none';
    }
  }

  private bfsDistance(start: Position, end: Position): number {
    if (start.x === end.x && start.y === end.y) return 0;
    const visited: boolean[][] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      visited.push(new Array(GRID_SIZE).fill(false));
    }
    const queue: Array<{ x: number; y: number; dist: number }> = [
      { ...start, dist: 0 },
    ];
    visited[start.y][start.x] = true;

    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const [dx, dy] of dirs) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        if (visited[ny][nx]) continue;
        if (this.terrain[ny][nx] === 'barrier') continue;

        if (nx === end.x && ny === end.y) return cur.dist + 1;
        visited[ny][nx] = true;
        queue.push({ x: nx, y: ny, dist: cur.dist + 1 });
      }
    }
    return -1;
  }

  private updateSpawnCountUI() {
    const el = document.getElementById('spawn-count');
    if (el) el.textContent = String(this.spawnPoints.length);
  }

  setTerrain(terrain: TerrainType) {
    this.currentTerrain = terrain;
  }

  setBrushSize(size: BrushSize) {
    this.brushSize = size;
  }

  setSymmetryMode(mode: SymmetryMode) {
    this.symmetryMode = mode;
  }

  setEditMode(mode: EditMode) {
    this.editMode = mode;
    this.canvas.style.cursor = mode === 'spawn' ? 'pointer' : 'crosshair';
  }

  clearMap() {
    this.terrain = this.createEmptyTerrain();
    this.spawnPoints = [];
    this.updateSpawnCountUI();
    this.checkSpawnWarnings();
    this.render();
  }

  async validateMap(name: string): Promise<MapValidationResult | null> {
    return new Promise((resolve) => {
      const mapData = {
        name,
        gridSize: GRID_SIZE,
        terrain: this.terrain,
        spawnPoints: this.spawnPoints,
      };

      const handler = (payload: any) => {
        this.network.off('map_validation', handler as any);
        resolve(payload as MapValidationResult);
      };
      this.network.once('map_validation', handler as any);

      this.network.send({ type: 'validate_map', payload: { mapData } });

      setTimeout(() => {
        this.network.off('map_validation', handler as any);
        resolve(null);
      }, 5000);
    });
  }

  async saveMap(name: string): Promise<CustomMapData | null> {
    return new Promise((resolve) => {
      const mapData = {
        name,
        gridSize: GRID_SIZE,
        terrain: this.terrain,
        spawnPoints: this.spawnPoints,
      };

      const handler = (payload: any) => {
        this.network.off('map_saved', handler as any);
        resolve(payload?.map || null);
      };
      this.network.once('map_saved', handler as any);

      this.network.send({ type: 'save_map', payload: { mapData } });

      setTimeout(() => {
        this.network.off('map_saved', handler as any);
        resolve(null);
      }, 5000);
    });
  }

  loadMap(map: CustomMapData) {
    this.terrain = map.terrain.map((row) => [...row]);
    this.spawnPoints = map.spawnPoints.map((p) => ({ ...p }));
    this.updateSpawnCountUI();
    this.checkSpawnWarnings();
    this.render();
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const terrain = this.terrain[y][x];
        ctx.fillStyle = TERRAIN_COLORS[terrain];
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID_SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(i * CELL_SIZE, 0);
      ctx.lineTo(i * CELL_SIZE, CANVAS_SIZE);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * CELL_SIZE);
      ctx.lineTo(CANVAS_SIZE, i * CELL_SIZE);
      ctx.stroke();
    }

    const center = (GRID_SIZE - 1) / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(
      (center + 0.5) * CELL_SIZE,
      (center + 0.5) * CELL_SIZE,
      (GRID_SIZE / 2 - 1) * CELL_SIZE,
      0,
      Math.PI * 2
    );
    ctx.stroke();

    this.spawnPoints.forEach((p, i) => {
      const cx = (p.x + 0.5) * CELL_SIZE;
      const cy = (p.y + 0.5) * CELL_SIZE;
      const r = CELL_SIZE * 0.4;

      ctx.beginPath();
      ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = SPAWN_COLORS[i % SPAWN_COLORS.length];
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.floor(CELL_SIZE * 0.5)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), cx, cy);
    });
  }
}

export async function fetchMapList(
  network: GameWebSocket
): Promise<MapListItem[]> {
  return new Promise((resolve) => {
    const handler = (payload: any) => {
      network.off('map_list', handler as any);
      resolve(payload?.maps || []);
    };
    network.once('map_list', handler as any);
    network.send({ type: 'list_maps', payload: {} });

    setTimeout(() => {
      network.off('map_list', handler as any);
      resolve([]);
    }, 5000);
  });
}
