import {
  GameState,
  Colony,
  Cell,
  Position,
  Player,
  AntibioticType,
  ActionType,
  TacticalMarker,
  MarkerType,
  TerrainType,
} from './types.js';

export interface RenderAnimation {
  type: 'attack' | 'spread' | 'mutation';
  position: Position;
  color: string;
  startTime: number;
  duration: number;
}

export interface RenderState {
  gameState: GameState | null;
  myPlayerId: string;
  selectedColonyId: string | null;
  hoveredCell: Position | null;
  currentAction: ActionType;
  animations: RenderAnimation[];
  markers: TacticalMarker[];
  markerMode: MarkerType | null;
}

const MICROBE_ICONS: Record<string, string> = {
  bacteria: '🦠',
  fungi: '🍄',
  protozoa: '🦠',
  phage: '☠️',
};

export class DishRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: RenderState;
  private width: number;
  private height: number;
  private centerX: number;
  private centerY: number;
  private dishRadius: number;
  private cellSize: number = 0;
  private gridOffset: { x: number; y: number } = { x: 0, y: 0 };
  private animationFrame: number = 0;
  private onClickCallback: ((pos: Position) => void) | null = null;
  private onHoverCallback: ((pos: Position | null) => void) | null = null;

  private isGridInsideDish(gx: number, gy: number, gridSize: number): boolean {
    const center = (gridSize - 1) / 2;
    const radius = gridSize / 2 - 0.5;
    const dx = gx - center;
    const dy = gy - center;
    return Math.sqrt(dx * dx + dy * dy) <= radius;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.width = canvas.width;
    this.height = canvas.height;
    this.centerX = this.width / 2;
    this.centerY = this.height / 2;
    this.dishRadius = Math.min(this.width, this.height) / 2 - 10;

    this.state = {
      gameState: null,
      myPlayerId: '',
      selectedColonyId: null,
      hoveredCell: null,
      currentAction: 'spread',
      animations: [],
      markers: [],
      markerMode: null,
    };

    this.setupInteraction();
    this.loop();
  }

  setGameState(state: GameState) {
    this.state.gameState = state;
    this.computeLayout();
  }

  setMyPlayerId(id: string) {
    this.state.myPlayerId = id;
  }

  setSelectedColony(id: string | null) {
    this.state.selectedColonyId = id;
  }

  setCurrentAction(action: ActionType) {
    this.state.currentAction = action;
  }

  setMarkers(markers: TacticalMarker[]) {
    this.state.markers = markers;
  }

  addMarker(marker: TacticalMarker) {
    this.state.markers.push(marker);
  }

  removeMarker(markerId: string) {
    this.state.markers = this.state.markers.filter((m) => m.id !== markerId);
  }

  setMarkerMode(mode: MarkerType | null) {
    this.state.markerMode = mode;
    if (mode) {
      this.canvas.style.cursor = 'crosshair';
    } else {
      this.canvas.style.cursor = 'crosshair';
    }
  }

  getMarkerMode(): MarkerType | null {
    return this.state.markerMode;
  }

  onClick(cb: (pos: Position) => void) {
    this.onClickCallback = cb;
  }

  onHover(cb: (pos: Position | null) => void) {
    this.onHoverCallback = cb;
  }

  addAnimation(anim: RenderAnimation) {
    this.state.animations.push(anim);
  }

  private computeLayout() {
    if (!this.state.gameState) return;
    const size = this.state.gameState.gridSize;
    const availableDiameter = this.dishRadius * 2 * 0.95;
    this.cellSize = availableDiameter / size;
    this.gridOffset.x = this.centerX - (size * this.cellSize) / 2;
    this.gridOffset.y = this.centerY - (size * this.cellSize) / 2;
  }

  private setupInteraction() {
    this.canvas.addEventListener('click', (e) => {
      const pos = this.screenToGrid(e.clientX, e.clientY);
      if (pos && this.onClickCallback) {
        this.onClickCallback(pos);
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      const pos = this.screenToGrid(e.clientX, e.clientY);
      this.state.hoveredCell = pos;
      if (this.onHoverCallback) {
        this.onHoverCallback(pos);
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.state.hoveredCell = null;
      if (this.onHoverCallback) {
        this.onHoverCallback(null);
      }
    });
  }

  private screenToGrid(screenX: number, screenY: number): Position | null {
    if (!this.state.gameState) return null;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (screenX - rect.left) * scaleX;
    const y = (screenY - rect.top) * scaleY;

    const dx = x - this.centerX;
    const dy = y - this.centerY;
    if (Math.sqrt(dx * dx + dy * dy) > this.dishRadius) {
      return null;
    }

    const gx = Math.floor((x - this.gridOffset.x) / this.cellSize);
    const gy = Math.floor((y - this.gridOffset.y) / this.cellSize);
    const size = this.state.gameState.gridSize;
    if (gx < 0 || gx >= size || gy < 0 || gy >= size) return null;
    return { x: gx, y: gy };
  }

  gridToScreen(pos: Position): { x: number; y: number } {
    return {
      x: this.gridOffset.x + pos.x * this.cellSize + this.cellSize / 2,
      y: this.gridOffset.y + pos.y * this.cellSize + this.cellSize / 2,
    };
  }

  private loop = () => {
    this.render();
    this.animationFrame = requestAnimationFrame(this.loop);
  };

  destroy() {
    cancelAnimationFrame(this.animationFrame);
  }

  private render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawDishBackground();

    if (!this.state.gameState) return;

    ctx.save();
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.dishRadius - 2, 0, Math.PI * 2);
    ctx.clip();

    this.drawNutrientLayer();
    this.drawTerrainLayer();
    this.drawAntibioticLayer();
    this.drawTemperatureLayer();
    this.drawColonies();
    this.drawMarkers();
    this.drawSelectionHighlight();
    this.drawHoverHighlight();
    this.drawActionPreview();
    this.drawAnimations();

    ctx.restore();

    this.drawDishBorder();
  }

  private drawDishBackground() {
    const ctx = this.ctx;

    const gradient = ctx.createRadialGradient(
      this.centerX, this.centerY, this.dishRadius * 0.1,
      this.centerX, this.centerY, this.dishRadius
    );
    gradient.addColorStop(0, '#f5f5dc');
    gradient.addColorStop(0.8, '#efe8d0');
    gradient.addColorStop(1, '#e8dcc0');

    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.dishRadius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  private drawDishBorder() {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.dishRadius, 0, Math.PI * 2);

    ctx.strokeStyle = '#8B7355';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, this.dishRadius - 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#b0a080';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawNutrientLayer() {
    if (!this.state.gameState) return;
    const ctx = this.ctx;
    const size = this.state.gameState.gridSize;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!this.isGridInsideDish(x, y, size)) continue;
        const cell = this.state.gameState.grid[y][x];
        const nutrientLevel = cell.environment.nutrient / cell.environment.maxNutrient;
        if (nutrientLevel < 0.05) continue;

        const sx = this.gridOffset.x + x * this.cellSize;
        const sy = this.gridOffset.y + y * this.cellSize;

        ctx.fillStyle = `rgba(255, 220, 150, ${nutrientLevel * 0.25})`;
        ctx.fillRect(sx, sy, this.cellSize + 1, this.cellSize + 1);
      }
    }
  }

  private drawAntibioticLayer() {
    if (!this.state.gameState) return;
    const ctx = this.ctx;
    const size = this.state.gameState.gridSize;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!this.isGridInsideDish(x, y, size)) continue;
        const cell = this.state.gameState.grid[y][x];
        const abx = cell.environment.antibiotics;
        let total = 0;
        for (const v of Object.values(abx) as number[]) {
          total = Math.max(total, v);
        }
        if (total <= 0) continue;

        const sx = this.gridOffset.x + x * this.cellSize;
        const sy = this.gridOffset.y + y * this.cellSize;

        ctx.fillStyle = `rgba(255, 50, 50, ${total * 0.35})`;
        ctx.fillRect(sx, sy, this.cellSize + 1, this.cellSize + 1);
      }
    }
  }

  private drawTemperatureLayer() {
    if (!this.state.gameState) return;
    const ctx = this.ctx;
    const size = this.state.gameState.gridSize;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!this.isGridInsideDish(x, y, size)) continue;
        const cell = this.state.gameState.grid[y][x];
        const temp = cell.environment.temperature;
        if (temp >= 30 && temp <= 40) continue;

        const sx = this.gridOffset.x + x * this.cellSize;
        const sy = this.gridOffset.y + y * this.cellSize;

        if (temp > 40) {
          const intensity = Math.min(1, (temp - 40) / 10);
          ctx.fillStyle = `rgba(255, 100, 0, ${intensity * 0.2})`;
          ctx.fillRect(sx, sy, this.cellSize + 1, this.cellSize + 1);
        } else if (temp < 30) {
          const intensity = Math.min(1, (30 - temp) / 10);
          ctx.fillStyle = `rgba(100, 150, 255, ${intensity * 0.2})`;
          ctx.fillRect(sx, sy, this.cellSize + 1, this.cellSize + 1);
        }
      }
    }
  }

  private drawTerrainLayer() {
    if (!this.state.gameState) return;
    const ctx = this.ctx;
    const size = this.state.gameState.gridSize;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!this.isGridInsideDish(x, y, size)) continue;
        const cell = this.state.gameState.grid[y][x];
        const terrain = (cell.environment as any).terrain as TerrainType | undefined;
        if (!terrain || terrain === 'normal') continue;

        const sx = this.gridOffset.x + x * this.cellSize;
        const sy = this.gridOffset.y + y * this.cellSize;
        const cs = this.cellSize + 1;

        switch (terrain) {
          case 'high_nutrient':
            ctx.fillStyle = 'rgba(124, 179, 66, 0.28)';
            ctx.fillRect(sx, sy, cs, cs);
            ctx.strokeStyle = 'rgba(124, 179, 66, 0.6)';
            ctx.lineWidth = 1;
            ctx.strokeRect(sx + 1, sy + 1, cs - 2, cs - 2);
            break;
          case 'barren':
            ctx.fillStyle = 'rgba(161, 136, 127, 0.32)';
            ctx.fillRect(sx, sy, cs, cs);
            ctx.strokeStyle = 'rgba(120, 90, 70, 0.5)';
            ctx.lineWidth = 1;
            ctx.strokeRect(sx + 1, sy + 1, cs - 2, cs - 2);
            break;
          case 'toxin':
            ctx.fillStyle = 'rgba(142, 36, 170, 0.22)';
            ctx.fillRect(sx, sy, cs, cs);
            ctx.beginPath();
            ctx.arc(
              sx + this.cellSize / 2,
              sy + this.cellSize / 2,
              this.cellSize * 0.18,
              0,
              Math.PI * 2
            );
            ctx.fillStyle = 'rgba(186, 104, 200, 0.8)';
            ctx.fill();
            break;
          case 'barrier':
            ctx.fillStyle = 'rgba(55, 71, 79, 0.85)';
            ctx.fillRect(sx, sy, cs, cs);
            ctx.strokeStyle = 'rgba(20, 25, 30, 0.9)';
            ctx.lineWidth = 2;
            ctx.strokeRect(sx + 2, sy + 2, cs - 4, cs - 4);
            ctx.beginPath();
            ctx.moveTo(sx + 4, sy + 4);
            ctx.lineTo(sx + cs - 4, sy + cs - 4);
            ctx.moveTo(sx + cs - 4, sy + 4);
            ctx.lineTo(sx + 4, sy + cs - 4);
            ctx.strokeStyle = 'rgba(20, 25, 30, 0.5)';
            ctx.lineWidth = 1;
            ctx.stroke();
            break;
        }
      }
    }
  }

  private drawColonies() {
    if (!this.state.gameState) return;
    const size = this.state.gameState.gridSize;

    for (const colony of this.state.gameState.colonies) {
      if (!this.isGridInsideDish(colony.position.x, colony.position.y, size)) continue;
      this.drawSingleColony(colony);
    }
  }

  private drawSingleColony(colony: Colony) {
    if (!this.state.gameState) return;
    if (!this.isGridInsideDish(colony.position.x, colony.position.y, this.state.gameState.gridSize)) return;
    const ctx = this.ctx;
    const player = this.state.gameState.players.find((p) => p.id === colony.playerId);
    if (!player) return;

    const screen = this.gridToScreen(colony.position);
    const biomassRatio = colony.biomass / colony.maxBiomass;
    const cellRadius = (this.cellSize * 0.42) * Math.max(0.3, Math.sqrt(biomassRatio));

    const baseColor = player.color;
    const deepColor = this.darkenColor(baseColor, 0.3);
    const lightColor = this.lightenColor(baseColor, 0.2);

    ctx.beginPath();
    ctx.arc(screen.x, screen.y, cellRadius, 0, Math.PI * 2);

    const gradient = ctx.createRadialGradient(
      screen.x - cellRadius * 0.3, screen.y - cellRadius * 0.3, cellRadius * 0.1,
      screen.x, screen.y, cellRadius
    );
    gradient.addColorStop(0, lightColor);
    gradient.addColorStop(0.6, baseColor);
    gradient.addColorStop(1, deepColor);
    ctx.fillStyle = gradient;
    ctx.fill();

    if (colony.biofilmLayers > 0) {
      const borderWidth = 1 + colony.biofilmLayers * 0.8;
      ctx.strokeStyle = `rgba(255,255,255,${0.4 + colony.biofilmLayers * 0.1})`;
      ctx.lineWidth = borderWidth;
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (colony.phageInjectionTurnsLeft !== null && colony.phageInjectionTurnsLeft > 0) {
      ctx.beginPath();
      ctx.arc(screen.x + cellRadius * 0.6, screen.y - cellRadius * 0.6, cellRadius * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = '#800080';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.max(8, cellRadius * 0.3)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(colony.phageInjectionTurnsLeft), screen.x + cellRadius * 0.6, screen.y - cellRadius * 0.6);
    }

    if (colony.position.y === 0 && this.state.myPlayerId === colony.playerId && this.state.selectedColonyId === colony.id) {
    }
  }

  private drawMarkers() {
    if (this.state.markers.length === 0 || !this.state.gameState) return;
    const ctx = this.ctx;
    const size = this.state.gameState.gridSize;

    for (const marker of this.state.markers) {
      if (!this.isGridInsideDish(marker.position.x, marker.position.y, size)) continue;

      const screen = this.gridToScreen(marker.position);
      const markerRadius = this.cellSize * 0.4;

      ctx.save();

      ctx.beginPath();
      ctx.arc(screen.x, screen.y, markerRadius + 3, 0, Math.PI * 2);
      ctx.strokeStyle = marker.color;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      if (marker.type === 'danger') {
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, markerRadius * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 80, 80, 0.35)';
        ctx.fill();
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ff4444';
        ctx.font = `bold ${Math.max(10, markerRadius * 0.9)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', screen.x, screen.y);
      } else if (marker.type === 'target') {
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, markerRadius * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(80, 200, 100, 0.3)';
        ctx.fill();
        ctx.strokeStyle = '#44cc66';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(screen.x, screen.y, markerRadius * 0.45, 0, Math.PI * 2);
        ctx.strokeStyle = '#44cc66';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#44cc66';
        ctx.fill();
      } else if (marker.type === 'defense') {
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, markerRadius * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(69, 183, 209, 0.3)';
        ctx.fill();
        ctx.strokeStyle = '#45B7D1';
        ctx.lineWidth = 2;
        ctx.stroke();

        const shieldW = markerRadius * 0.7;
        const shieldH = markerRadius * 0.85;
        ctx.beginPath();
        ctx.moveTo(screen.x, screen.y - shieldH / 2);
        ctx.quadraticCurveTo(screen.x + shieldW, screen.y - shieldH / 3, screen.x + shieldW * 0.8, screen.y + shieldH * 0.1);
        ctx.quadraticCurveTo(screen.x + shieldW * 0.4, screen.y + shieldH / 2, screen.x, screen.y + shieldH * 0.6);
        ctx.quadraticCurveTo(screen.x - shieldW * 0.4, screen.y + shieldH / 2, screen.x - shieldW * 0.8, screen.y + shieldH * 0.1);
        ctx.quadraticCurveTo(screen.x - shieldW, screen.y - shieldH / 3, screen.x, screen.y - shieldH / 2);
        ctx.fillStyle = 'rgba(69, 183, 209, 0.5)';
        ctx.fill();
        ctx.strokeStyle = '#45B7D1';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  private drawSelectionHighlight() {
    if (!this.state.gameState || !this.state.selectedColonyId) return;
    const colony = this.state.gameState.colonies.find((c) => c.id === this.state.selectedColonyId);
    if (!colony) return;
    if (!this.isGridInsideDish(colony.position.x, colony.position.y, this.state.gameState.gridSize)) return;

    const ctx = this.ctx;
    const screen = this.gridToScreen(colony.position);
    const cellRadius = this.cellSize * 0.5;

    ctx.beginPath();
    ctx.arc(screen.x, screen.y, cellRadius + 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawHoverHighlight() {
    if (!this.state.gameState || !this.state.hoveredCell) return;
    const { x, y } = this.state.hoveredCell;
    const size = this.state.gameState.gridSize;
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    if (!this.isGridInsideDish(x, y, size)) return;

    const ctx = this.ctx;
    const sx = this.gridOffset.x + x * this.cellSize;
    const sy = this.gridOffset.y + y * this.cellSize;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx, sy, this.cellSize, this.cellSize);
  }

  private drawActionPreview() {
    if (!this.state.gameState || !this.state.selectedColonyId || !this.state.hoveredCell) return;
    const size = this.state.gameState.gridSize;
    const { x, y } = this.state.hoveredCell;
    if (!this.isGridInsideDish(x, y, size)) return;

    const ctx = this.ctx;
    const colony = this.state.gameState.colonies.find((c) => c.id === this.state.selectedColonyId);
    if (!colony) return;
    if (!this.isGridInsideDish(colony.position.x, colony.position.y, size)) return;

    const dist = Math.sqrt(
      Math.pow(this.state.hoveredCell.x - colony.position.x, 2) +
      Math.pow(this.state.hoveredCell.y - colony.position.y, 2)
    );

    let maxDist = 2;
    if (this.state.currentAction === 'spread') {
      maxDist = 5;
    }

    const isValid = dist > 0 && dist <= maxDist;
    const screen = this.gridToScreen(this.state.hoveredCell);
    const cellRadius = this.cellSize * 0.35;

    ctx.beginPath();
    ctx.arc(screen.x, screen.y, cellRadius, 0, Math.PI * 2);
    ctx.fillStyle = isValid ? 'rgba(0,255,100,0.25)' : 'rgba(255,50,50,0.25)';
    ctx.fill();
    ctx.strokeStyle = isValid ? 'rgba(0,255,100,0.7)' : 'rgba(255,50,50,0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private drawAnimations() {
    if (this.state.animations.length === 0 || !this.state.gameState) return;
    const ctx = this.ctx;
    const now = Date.now();
    const toRemove: number[] = [];
    const size = this.state.gameState.gridSize;

    for (let i = 0; i < this.state.animations.length; i++) {
      const anim = this.state.animations[i];
      if (!this.isGridInsideDish(anim.position.x, anim.position.y, size)) {
        toRemove.push(i);
        continue;
      }

      const elapsed = now - anim.startTime;
      const progress = Math.min(1, elapsed / anim.duration);
      if (progress >= 1) {
        toRemove.push(i);
        continue;
      }

      const screen = this.gridToScreen(anim.position);
      const baseRadius = this.cellSize * 0.5;

      if (anim.type === 'attack') {
        const radius = baseRadius * (0.5 + progress * 1.5);
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = anim.color;
        ctx.globalAlpha = 1 - progress;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (anim.type === 'spread') {
        for (let j = 0; j < 5; j++) {
          const angle = (j / 5) * Math.PI * 2 + progress * Math.PI;
          const dist = baseRadius * progress * 1.2;
          const px = screen.x + Math.cos(angle) * dist;
          const py = screen.y + Math.sin(angle) * dist;
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fillStyle = anim.color;
          ctx.globalAlpha = 1 - progress;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      } else if (anim.type === 'mutation') {
        ctx.fillStyle = `rgba(180, 50, 255, ${1 - progress})`;
        ctx.font = `bold ${14 + progress * 10}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🧬', screen.x, screen.y - progress * 30);
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.state.animations.splice(toRemove[i], 1);
    }
  }

  getColonyAt(pos: Position): Colony | null {
    if (!this.state.gameState) return null;
    const cell = this.state.gameState.grid[pos.y]?.[pos.x];
    return cell?.colony || null;
  }

  getPlayer(playerId: string): Player | undefined {
    return this.state.gameState?.players.find((p) => p.id === playerId);
  }

  private darkenColor(hex: string, amount: number): string {
    return this.adjustColor(hex, -amount);
  }

  private lightenColor(hex: string, amount: number): string {
    return this.adjustColor(hex, amount);
  }

  private adjustColor(hex: string, amount: number): string {
    const c = hex.replace('#', '');
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const adj = (v: number) =>
      Math.max(0, Math.min(255, Math.round(v + (amount > 0 ? (255 - v) * amount : v * amount))));
    const toHex = (v: number) => adj(v).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  getCellSize(): number {
    return this.cellSize;
  }
}
