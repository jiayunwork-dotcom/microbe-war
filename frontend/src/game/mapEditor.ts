import {
  TerrainType,
  SymmetryMode,
  BrushSize,
  EditMode,
  Position,
  CustomMapData,
  MapListItem,
  MapValidationResult,
  MapPresetType,
} from './types.js';
import { GameWebSocket } from './network.js';

const GRID_SIZE = 30;
const CANVAS_SIZE = 600;
const CELL_SIZE = CANVAS_SIZE / GRID_SIZE;
const MAX_HISTORY = 50;

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

interface HistoryEntry {
  terrainChanges: Array<{ x: number; y: number; before: TerrainType; after: TerrainType }>;
  spawnChanges: { before: Position[]; after: Position[] };
}

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
  private currentStrokeChanges: Map<string, TerrainType> = new Map();

  private historyStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(canvas: HTMLCanvasElement, network: GameWebSocket) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.network = network;

    this.terrain = this.createEmptyTerrain();
    this.spawnPoints = [];

    this.setupCanvasListeners();
    this.setupKeyboardListeners();
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

  private setupKeyboardListeners() {
    document.addEventListener('keydown', (e) => {
      const mapEditorScreen = document.getElementById('map-editor-screen');
      if (!mapEditorScreen?.classList.contains('active')) return;
      const isInput = (e.target as HTMLElement)?.tagName === 'INPUT' ||
                      (e.target as HTMLElement)?.tagName === 'SELECT' ||
                      (e.target as HTMLElement)?.tagName === 'TEXTAREA';
      if (isInput) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        this.redo();
      }
    });
  }

  private pushHistory(entry: HistoryEntry) {
    this.historyStack.push(entry);
    if (this.historyStack.length > MAX_HISTORY) {
      this.historyStack.shift();
    }
    this.redoStack = [];
    this.updateUndoRedoUI();
  }

  undo() {
    if (this.historyStack.length === 0) return;
    const entry = this.historyStack.pop()!;
    this.redoStack.push(entry);

    for (const change of entry.terrainChanges) {
      this.terrain[change.y][change.x] = change.before;
      if (change.before === 'barrier') {
        this.spawnPoints = this.spawnPoints.filter(
          (p) => !(p.x === change.x && p.y === change.y)
        );
      }
    }
    this.spawnPoints = entry.spawnChanges.before.map((p) => ({ ...p }));

    this.updateSpawnCountUI();
    this.checkSpawnWarnings();
    this.render();
    this.updateUndoRedoUI();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const entry = this.redoStack.pop()!;
    this.historyStack.push(entry);

    for (const change of entry.terrainChanges) {
      this.terrain[change.y][change.x] = change.after;
      if (change.after === 'barrier') {
        this.spawnPoints = this.spawnPoints.filter(
          (p) => !(p.x === change.x && p.y === change.y)
        );
      }
    }
    this.spawnPoints = entry.spawnChanges.after.map((p) => ({ ...p }));

    this.updateSpawnCountUI();
    this.checkSpawnWarnings();
    this.render();
    this.updateUndoRedoUI();
  }

  canUndo(): boolean {
    return this.historyStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private updateUndoRedoUI() {
    const undoBtn = document.getElementById('btn-undo') as HTMLButtonElement;
    const redoBtn = document.getElementById('btn-redo') as HTMLButtonElement;
    if (undoBtn) undoBtn.disabled = !this.canUndo();
    if (redoBtn) redoBtn.disabled = !this.canRedo();
  }

  private onMouseDown(e: MouseEvent) {
    const { x, y } = this.getGridCoords(e);
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return;

    if (this.editMode === 'terrain') {
      this.isDrawing = true;
      this.lastDrawnCells.clear();
      this.currentStrokeChanges.clear();
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
    if (this.isDrawing && this.currentStrokeChanges.size > 0) {
      const beforeSpawn = this.spawnPoints.map((p) => ({ ...p }));
      const terrainChanges: HistoryEntry['terrainChanges'] = [];
      for (const [key, after] of this.currentStrokeChanges) {
        const [xs, ys] = key.split(',');
        const cx = parseInt(xs, 10);
        const cy = parseInt(ys, 10);
        terrainChanges.push({ x: cx, y: cy, before: after, after: this.terrain[cy][cx] });
      }
      terrainChanges.forEach((c) => {
        const temp = c.before;
        c.before = c.after;
        c.after = temp;
      });
      const afterSpawn = this.spawnPoints.map((p) => ({ ...p }));
      this.pushHistory({ terrainChanges, spawnChanges: { before: beforeSpawn, after: afterSpawn } });
    }
    this.isDrawing = false;
    this.lastDrawnCells.clear();
    this.currentStrokeChanges.clear();
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
        const beforeTerrain = this.terrain[y][x];
        if (!this.currentStrokeChanges.has(key)) {
          this.currentStrokeChanges.set(key, beforeTerrain);
        }
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
    const beforeSpawn = this.spawnPoints.map((p) => ({ ...p }));
    let changed = false;

    if (isRightClick) {
      const originalLen = this.spawnPoints.length;
      this.spawnPoints = this.spawnPoints.filter(
        (p) => !(p.x === x && p.y === y)
      );
      changed = this.spawnPoints.length !== originalLen;
    } else {
      if (this.terrain[y][x] === 'barrier') {
        this.showWarning('出生点不能放在屏障区上！');
        return;
      }

      if (this.spawnPoints.some((p) => p.x === x && p.y === y)) {
        this.spawnPoints = this.spawnPoints.filter(
          (p) => !(p.x === x && p.y === y)
        );
        changed = true;
      } else {
        if (this.spawnPoints.length >= 6) {
          this.showWarning('最多只能放置6个出生点！');
          return;
        }
        this.spawnPoints.push({ x, y });
        changed = true;
      }
    }

    if (changed) {
      const afterSpawn = this.spawnPoints.map((p) => ({ ...p }));
      this.pushHistory({ terrainChanges: [], spawnChanges: { before: beforeSpawn, after: afterSpawn } });
    }
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
    const beforeTerrain: HistoryEntry['terrainChanges'] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        beforeTerrain.push({ x, y, before: this.terrain[y][x], after: 'normal' });
      }
    }
    const beforeSpawn = this.spawnPoints.map((p) => ({ ...p }));

    this.terrain = this.createEmptyTerrain();
    this.spawnPoints = [];

    this.pushHistory({
      terrainChanges: beforeTerrain,
      spawnChanges: { before: beforeSpawn, after: [] },
    });

    this.updateSpawnCountUI();
    this.checkSpawnWarnings();
    this.render();
  }

  loadPreset(preset: MapPresetType) {
    if (!confirm(`确定要加载预设"${this.getPresetName(preset)}"吗？当前编辑内容将被覆盖。`)) {
      return;
    }

    const beforeTerrain: HistoryEntry['terrainChanges'] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        beforeTerrain.push({ x, y, before: this.terrain[y][x], after: 'normal' });
      }
    }
    const beforeSpawn = this.spawnPoints.map((p) => ({ ...p }));

    this.terrain = this.createEmptyTerrain();
    this.spawnPoints = [];

    switch (preset) {
      case 'arena':
        this.generateArena();
        break;
      case 'maze':
        this.generateMaze();
        break;
      case 'toxic_swamp':
        this.generateToxicSwamp();
        break;
    }

    const afterTerrain: HistoryEntry['terrainChanges'] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        afterTerrain.push({ x, y, before: 'normal', after: this.terrain[y][x] });
      }
    }
    const afterSpawn = this.spawnPoints.map((p) => ({ ...p }));

    const combinedChanges: HistoryEntry['terrainChanges'] = [];
    for (let i = 0; i < beforeTerrain.length; i++) {
      const b = beforeTerrain[i];
      const a = afterTerrain[i];
      if (b.before !== a.after) {
        combinedChanges.push({ x: b.x, y: b.y, before: b.before, after: a.after });
      }
    }

    this.pushHistory({
      terrainChanges: combinedChanges,
      spawnChanges: { before: beforeSpawn, after: afterSpawn },
    });

    this.updateSpawnCountUI();
    this.checkSpawnWarnings();
    this.render();
  }

  private getPresetName(preset: MapPresetType): string {
    switch (preset) {
      case 'arena': return '竞技场';
      case 'maze': return '迷宫';
      case 'toxic_swamp': return '毒沼';
    }
  }

  private generateArena() {
    const center = Math.floor(GRID_SIZE / 2);
    const diamondRadius = 12;

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const dist = Math.abs(x - center) + Math.abs(y - center);
        if (dist > diamondRadius) {
          this.terrain[y][x] = 'barrier';
        }
      }
    }

    const spawnOffsets = [
      { dx: -9, dy: 0 },
      { dx: 9, dy: 0 },
      { dx: 0, dy: -9 },
      { dx: 0, dy: 9 },
      { dx: -6, dy: -6 },
      { dx: 6, dy: 6 },
    ];

    const spawnPoints: Position[] = spawnOffsets.map((offset) => ({
      x: center + offset.dx,
      y: center + offset.dy,
    }));

    for (const sp of spawnPoints) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = sp.x + dx;
          const ny = sp.y + dy;
          if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
            const dist = Math.abs(nx - center) + Math.abs(ny - center);
            if (dist <= diamondRadius) {
              this.terrain[ny][nx] = 'normal';
            }
          }
        }
      }
      this.spawnPoints.push(sp);
    }

    const highNutrientRadius = 4;
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const dist = Math.sqrt(Math.pow(x - center, 2) + Math.pow(y - center, 2));
        if (dist <= highNutrientRadius) {
          this.terrain[y][x] = 'high_nutrient';
        }
      }
    }
  }

  private generateMaze() {
    const maze: boolean[][] = [];
    for (let y = 0; y < GRID_SIZE; y++) {
      maze.push(new Array(GRID_SIZE).fill(true));
    }

    const carve = (x: number, y: number) => {
      maze[y][x] = false;
      const dirs = [
        [0, -2], [0, 2], [-2, 0], [2, 0]
      ].sort(() => Math.random() - 0.5);

      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx > 0 && nx < GRID_SIZE - 1 && ny > 0 && ny < GRID_SIZE - 1 && maze[ny][nx]) {
          const midX = x + Math.floor(dx / 2);
          const midY = y + Math.floor(dy / 2);
          maze[midY][midX] = false;
          carve(nx, ny);
        }
      }
    };

    carve(1, 1);

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        if (maze[y][x]) {
          this.terrain[y][x] = 'barrier';
        } else {
          this.terrain[y][x] = Math.random() < 0.1 ? 'high_nutrient' : 'normal';
        }
      }
    }

    const openCells: Position[] = [];
    for (let y = 2; y < GRID_SIZE - 2; y++) {
      for (let x = 2; x < GRID_SIZE - 2; x++) {
        if (this.terrain[y][x] !== 'barrier') {
          openCells.push({ x, y });
        }
      }
    }

    const shuffled = openCells.sort(() => Math.random() - 0.5);
    const spawnPositions: Position[] = [];
    for (const cell of shuffled) {
      if (spawnPositions.length >= 6) break;
      const farEnough = spawnPositions.every(
        (sp) => Math.abs(sp.x - cell.x) + Math.abs(sp.y - cell.y) >= 12
      );
      if (farEnough) {
        spawnPositions.push(cell);
      }
    }

    for (const sp of spawnPositions) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = sp.x + dx;
          const ny = sp.y + dy;
          if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
            this.terrain[ny][nx] = 'normal';
          }
        }
      }
      this.spawnPoints.push(sp);
    }
  }

  private generateToxicSwamp() {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const noise = this.simplexNoise(x * 0.15, y * 0.15);
        if (noise < 0.3) {
          this.terrain[y][x] = 'toxin';
        } else if (noise < 0.5) {
          this.terrain[y][x] = 'barren';
        } else {
          this.terrain[y][x] = 'normal';
        }
      }
    }

    const halfGrid = Math.floor(GRID_SIZE / 2);
    const islandCenters: Position[] = [
      { x: 5, y: 5 },
      { x: GRID_SIZE - 6, y: 5 },
      { x: 5, y: GRID_SIZE - 6 },
      { x: GRID_SIZE - 6, y: GRID_SIZE - 6 },
      { x: halfGrid, y: 5 },
      { x: halfGrid, y: GRID_SIZE - 6 },
    ];

    for (let i = 0; i < islandCenters.length; i++) {
      const center = islandCenters[i];
      const radius = 3 + Math.floor(Math.random() * 2);
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const dist = Math.sqrt(Math.pow(x - center.x, 2) + Math.pow(y - center.y, 2));
          if (dist <= radius) {
            this.terrain[y][x] = dist <= radius * 0.5 ? 'high_nutrient' : 'normal';
          }
        }
      }
    }

    for (const sp of islandCenters) {
      this.spawnPoints.push({ x: sp.x, y: sp.y });
    }
  }

  private simplexNoise(x: number, y: number): number {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const n2 = Math.sin((x + 100) * 45.164 + (y + 200) * 92.133) * 12345.6789;
    return ((n - Math.floor(n)) + (n2 - Math.floor(n2))) / 2;
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
    this.historyStack = [];
    this.redoStack = [];
    this.updateUndoRedoUI();
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

function getClientId(): string {
  let cid = localStorage.getItem('mw_client_id');
  if (!cid) {
    cid = 'cid_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    localStorage.setItem('mw_client_id', cid);
  }
  return cid;
}

export function getOrCreateClientId(): string {
  return getClientId();
}

export async function fetchMapList(
  network: GameWebSocket
): Promise<MapListItem[]> {
  return new Promise((resolve) => {
    const handler = (payload: any) => {
      network.off('map_list', handler as any);
      const maps: MapListItem[] = payload?.maps || [];
      const clientId = getClientId();
      const mapsWithLiked = maps.map((m) => ({
        ...m,
        isLiked: m.likedBy?.includes(clientId) || false,
      }));
      resolve(mapsWithLiked);
    };
    network.once('map_list', handler as any);
    network.send({ type: 'list_maps', payload: {} });

    setTimeout(() => {
      network.off('map_list', handler as any);
      resolve([]);
    }, 5000);
  });
}

export function thumbnailToDataUrl(thumbnail: string): string {
  const size = 64;
  const bytes = new Uint8Array(
    atob(thumbnail)
      .split('')
      .map((c) => c.charCodeAt(0))
  );
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(size, size);
  for (let i = 0; i < bytes.length && i < imageData.data.length; i++) {
    imageData.data[i] = bytes[i];
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}

export function renderThumbnailToCanvas(
  thumbnail: string,
  targetCanvas: HTMLCanvasElement
) {
  const size = 64;
  const bytes = new Uint8Array(
    atob(thumbnail)
      .split('')
      .map((c) => c.charCodeAt(0))
  );
  const ctx = targetCanvas.getContext('2d')!;
  targetCanvas.width = size;
  targetCanvas.height = size;
  const imageData = ctx.createImageData(size, size);
  for (let i = 0; i < bytes.length && i < imageData.data.length; i++) {
    imageData.data[i] = bytes[i];
  }
  ctx.putImageData(imageData, 0, 0);
}
