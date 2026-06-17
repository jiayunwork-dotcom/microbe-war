import {
  Position,
  Cell,
  CellEnvironment,
  AntibioticType,
  GlobalEventType,
  GlobalEvent,
  GameState,
  AntibioticSpillEvent,
  NutrientDepletionEvent,
  TemperatureSurgeEvent,
  PhageOutbreakEvent,
  CustomMapData,
  TerrainType,
} from './types';

export const GRID_SIZE = 30;
export const NUTRIENT_REGEN_RATE = 0.02;
export const MAX_NUTRIENT_CENTER = 1.0;
export const MAX_NUTRIENT_EDGE = 0.3;
export const DISH_RADIUS_RATIO = 0.48;

export function getDishRadius(gridSize: number): number {
  return gridSize * DISH_RADIUS_RATIO;
}

export function isInsideDish(x: number, y: number, gridSize: number): boolean {
  const center = (gridSize - 1) / 2;
  const radius = getDishRadius(gridSize);
  const dist = Math.sqrt(Math.pow(x - center, 2) + Math.pow(y - center, 2));
  return dist <= radius;
}

export function getDishCellCount(gridSize: number): number {
  let count = 0;
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (isInsideDish(x, y, gridSize)) count++;
    }
  }
  return count;
}

export function createInitialGrid(size: number): Cell[][] {
  const grid: Cell[][] = [];
  const center = (size - 1) / 2;
  const radius = getDishRadius(size);

  for (let y = 0; y < size; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < size; x++) {
      const distFromCenter = Math.sqrt(
        Math.pow(x - center, 2) + Math.pow(y - center, 2)
      );
      const inside = distFromCenter <= radius;

      let maxNutrient = 0;
      let temperature = 25;
      let pH = 7.0;

      if (inside) {
        const distFactor = 1 - distFromCenter / radius;
        maxNutrient =
          MAX_NUTRIENT_EDGE +
          (MAX_NUTRIENT_CENTER - MAX_NUTRIENT_EDGE) * distFactor;
        temperature = 35 + Math.random() * 5 - 2.5;
        pH = 6.8 + Math.random() * 0.8 - 0.4;
      }

      const environment: CellEnvironment = {
        nutrient: maxNutrient,
        maxNutrient: maxNutrient,
        temperature,
        pH,
        antibiotics: {},
        terrain: 'normal',
      };

      row.push({
        position: { x, y },
        colony: null,
        environment,
      });
    }
    grid.push(row);
  }

  addRandomHotSpots(grid, size);
  addRandomPhZones(grid, size);
  addRandomAntibioticPatches(grid, size);

  return grid;
}

function addRandomHotSpots(grid: Cell[][], size: number) {
  const hotSpots = 2 + Math.floor(Math.random() * 3);
  const dishRadius = getDishRadius(size);
  const center = (size - 1) / 2;
  for (let i = 0; i < hotSpots; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * dishRadius * 0.7;
    const cx = Math.floor(center + Math.cos(angle) * r);
    const cy = Math.floor(center + Math.sin(angle) * r);
    const radius = 3 + Math.floor(Math.random() * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isInsideDish(x, y, size)) continue;
        const dist = Math.sqrt(
          Math.pow(x - cx, 2) + Math.pow(y - cy, 2)
        );
        if (dist < radius) {
          grid[y][x].environment.temperature +=
            (5 + Math.random() * 5) * (1 - dist / radius);
        }
      }
    }
  }
}

function addRandomPhZones(grid: Cell[][], size: number) {
  const zones = 2 + Math.floor(Math.random() * 2);
  const dishRadius = getDishRadius(size);
  const center = (size - 1) / 2;
  for (let i = 0; i < zones; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * dishRadius * 0.7;
    const cx = Math.floor(center + Math.cos(angle) * r);
    const cy = Math.floor(center + Math.sin(angle) * r);
    const radius = 3 + Math.floor(Math.random() * 4);
    const isAcidic = Math.random() > 0.5;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isInsideDish(x, y, size)) continue;
        const dist = Math.sqrt(
          Math.pow(x - cx, 2) + Math.pow(y - cy, 2)
        );
        if (dist < radius) {
          const factor = 1 - dist / radius;
          if (isAcidic) {
            grid[y][x].environment.pH -= 0.8 * factor;
          } else {
            grid[y][x].environment.pH += 0.8 * factor;
          }
          grid[y][x].environment.pH = Math.max(4.5, Math.min(9.0, grid[y][x].environment.pH));
        }
      }
    }
  }
}

function addRandomAntibioticPatches(grid: Cell[][], size: number) {
  const types: AntibioticType[] = ['penicillin', 'streptomycin', 'tetracycline'];
  const patches = 1 + Math.floor(Math.random() * 2);
  const dishRadius = getDishRadius(size);
  const center = (size - 1) / 2;
  for (let i = 0; i < patches; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * dishRadius * 0.7;
    const cx = Math.floor(center + Math.cos(angle) * r);
    const cy = Math.floor(center + Math.sin(angle) * r);
    const radius = 2 + Math.floor(Math.random() * 2);
    const type = types[Math.floor(Math.random() * types.length)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isInsideDish(x, y, size)) continue;
        const dist = Math.sqrt(
          Math.pow(x - cx, 2) + Math.pow(y - cy, 2)
        );
        if (dist < radius) {
          grid[y][x].environment.antibiotics[type] =
            0.3 + 0.5 * (1 - dist / radius);
        }
      }
    }
  }
}

export function regenerateNutrients(grid: Cell[][], size: number) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isInsideDish(x, y, size)) continue;
      const cell = grid[y][x];
      if (cell.environment.nutrient < cell.environment.maxNutrient) {
        cell.environment.nutrient = Math.min(
          cell.environment.maxNutrient,
          cell.environment.nutrient +
            cell.environment.maxNutrient * NUTRIENT_REGEN_RATE
        );
      }
    }
  }
}

export function perturbEnvironment(grid: Cell[][], size: number) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isInsideDish(x, y, size)) continue;
      const env = grid[y][x].environment;
      env.temperature += (Math.random() - 0.5) * 0.4;
      env.temperature = Math.max(20, Math.min(50, env.temperature));
      env.pH += (Math.random() - 0.5) * 0.05;
      env.pH = Math.max(4.5, Math.min(9.0, env.pH));

      const antibioticTypes: AntibioticType[] = [
        'penicillin',
        'streptomycin',
        'tetracycline',
      ];
      for (const atype of antibioticTypes) {
        if (env.antibiotics[atype] !== undefined) {
          env.antibiotics[atype]! *= 0.95;
          if (env.antibiotics[atype]! < 0.01) {
            delete env.antibiotics[atype];
          }
        }
      }
    }
  }
}

export function triggerGlobalEvent(
  gameState: GameState
): GlobalEvent | null {
  if (gameState.turn % 10 !== 0) return null;

  const eventTypes: GlobalEventType[] = [
    'antibiotic_spill',
    'temperature_surge',
    'nutrient_depletion',
    'phage_ outbreak',
  ];
  const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];

  switch (eventType) {
    case 'antibiotic_spill': {
      const types: AntibioticType[] = ['penicillin', 'streptomycin', 'tetracycline'];
      const antibioticType = types[Math.floor(Math.random() * types.length)];
      const affectedArea: Position[] = [];
      const center = (gameState.gridSize - 1) / 2;
      const dishRadius = getDishRadius(gameState.gridSize);
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * dishRadius * 0.6;
      const cx = Math.floor(center + Math.cos(angle) * r);
      const cy = Math.floor(center + Math.sin(angle) * r);
      const radius = 4 + Math.floor(Math.random() * 4);

      for (let y = 0; y < gameState.gridSize; y++) {
        for (let x = 0; x < gameState.gridSize; x++) {
          if (!isInsideDish(x, y, gameState.gridSize)) continue;
          const dist = Math.sqrt(
            Math.pow(x - cx, 2) + Math.pow(y - cy, 2)
          );
          if (dist < radius) {
            affectedArea.push({ x, y });
            const intensity = 0.4 + 0.4 * (1 - dist / radius);
            gameState.grid[y][x].environment.antibiotics[antibioticType] =
              Math.max(
                gameState.grid[y][x].environment.antibiotics[antibioticType] ||
                  0,
                intensity
              );
          }
        }
      }

      const event: AntibioticSpillEvent = {
        type: 'antibiotic_spill',
        description: `抗生素 ${antibioticName(antibioticType)} 洒落覆盖区域！`,
        affectedArea,
        turn: gameState.turn,
        antibioticType,
      };
      return event;
    }

    case 'temperature_surge': {
      const delta = Math.random() > 0.5 ? 5 : -5;
      for (let y = 0; y < gameState.gridSize; y++) {
        for (let x = 0; x < gameState.gridSize; x++) {
          if (!isInsideDish(x, y, gameState.gridSize)) continue;
          gameState.grid[y][x].environment.temperature += delta;
          gameState.grid[y][x].environment.temperature = Math.max(
            20,
            Math.min(50, gameState.grid[y][x].environment.temperature)
          );
        }
      }

      const event: TemperatureSurgeEvent = {
        type: 'temperature_surge',
        description: `温度骤变 ${delta > 0 ? '上升' : '下降'} ${Math.abs(
          delta
        )}度！`,
        turn: gameState.turn,
        temperatureDelta: delta,
      };
      return event;
    }

    case 'nutrient_depletion': {
      const affectedArea: Position[] = [];
      const center = (gameState.gridSize - 1) / 2;
      const dishRadius = getDishRadius(gameState.gridSize);
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * dishRadius * 0.6;
      const cx = Math.floor(center + Math.cos(angle) * r);
      const cy = Math.floor(center + Math.sin(angle) * r);
      const radius = 5 + Math.floor(Math.random() * 4);

      for (let y = 0; y < gameState.gridSize; y++) {
        for (let x = 0; x < gameState.gridSize; x++) {
          if (!isInsideDish(x, y, gameState.gridSize)) continue;
          const dist = Math.sqrt(
            Math.pow(x - cx, 2) + Math.pow(y - cy, 2)
          );
          if (dist < radius) {
            affectedArea.push({ x, y });
            gameState.grid[y][x].environment.nutrient *= 0.1;
          }
        }
      }

      const event: NutrientDepletionEvent = {
        type: 'nutrient_depletion',
        description: '某区域营养突然枯竭！',
        affectedArea,
        turn: gameState.turn,
      };
      return event;
    }

    case 'phage_ outbreak': {
      const damage = 15 + Math.floor(Math.random() * 10);
      for (const colony of gameState.colonies) {
        if (colony.microbeType === 'bacteria') {
          colony.biomass = Math.max(0, colony.biomass - damage);
        }
      }

      const event: PhageOutbreakEvent = {
        type: 'phage_ outbreak',
        description: `噬菌体爆发！所有细菌类菌落受到 ${damage} 点伤害！`,
        turn: gameState.turn,
        damagePerBacteriaColony: damage,
      };
      return event;
    }
  }
}

function antibioticName(type: AntibioticType): string {
  const names: Record<AntibioticType, string> = {
    penicillin: '青霉素',
    streptomycin: '链霉素',
    tetracycline: '四环素',
  };
  return names[type];
}

export function createInitialGridFromCustomMap(
  size: number,
  customMap: CustomMapData
): Cell[][] {
  const grid: Cell[][] = [];
  const center = (size - 1) / 2;
  const radius = getDishRadius(size);

  for (let y = 0; y < size; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < size; x++) {
      const distFromCenter = Math.sqrt(
        Math.pow(x - center, 2) + Math.pow(y - center, 2)
      );
      const inside = distFromCenter <= radius;

      let maxNutrient = 0;
      let temperature = 25;
      let pH = 7.0;

      const terrain: TerrainType =
        customMap.terrain[y]?.[x] || 'normal';

      if (inside) {
        const distFactor = 1 - distFromCenter / radius;
        let baseNutrient =
          MAX_NUTRIENT_EDGE +
          (MAX_NUTRIENT_CENTER - MAX_NUTRIENT_EDGE) * distFactor;

        switch (terrain) {
          case 'high_nutrient':
            baseNutrient *= 2;
            break;
          case 'barren':
            baseNutrient *= 0.25;
            break;
          case 'barrier':
            baseNutrient = 0;
            break;
          default:
            break;
        }

        maxNutrient = baseNutrient;
        temperature = 35 + Math.random() * 5 - 2.5;
        pH = 6.8 + Math.random() * 0.8 - 0.4;
      }

      const environment: CellEnvironment = {
        nutrient: maxNutrient,
        maxNutrient: maxNutrient,
        temperature,
        pH,
        antibiotics: {},
        terrain,
      };

      row.push({
        position: { x, y },
        colony: null,
        environment,
      });
    }
    grid.push(row);
  }

  addRandomHotSpotsFromTerrain(grid, size, customMap.terrain);
  addRandomPhZones(grid, size);

  return grid;
}

function addRandomHotSpotsFromTerrain(
  grid: Cell[][],
  size: number,
  terrain: TerrainType[][]
) {
  const hotSpots = 2 + Math.floor(Math.random() * 3);
  const dishRadius = getDishRadius(size);
  const center = (size - 1) / 2;
  for (let i = 0; i < hotSpots; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * dishRadius * 0.7;
    const cx = Math.floor(center + Math.cos(angle) * r);
    const cy = Math.floor(center + Math.sin(angle) * r);
    const radius = 3 + Math.floor(Math.random() * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isInsideDish(x, y, size)) continue;
        if (terrain[y]?.[x] === 'barrier') continue;
        const dist = Math.sqrt(
          Math.pow(x - cx, 2) + Math.pow(y - cy, 2)
        );
        if (dist < radius) {
          grid[y][x].environment.temperature +=
            (5 + Math.random() * 5) * (1 - dist / radius);
        }
      }
    }
  }
}
