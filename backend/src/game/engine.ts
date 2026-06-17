import {
  GameState,
  Position,
  Colony,
  Player,
  PlayerAction,
  Cell,
  AntibioticType,
  EventLogEntry,
  MicrobeType,
  GlobalEvent,
  KillEvent,
  TurnResult,
} from './types';
import {
  GRID_SIZE,
  createInitialGrid,
  regenerateNutrients,
  perturbEnvironment,
  triggerGlobalEvent,
  isInsideDish,
  getDishCellCount,
  createInitialGridFromCustomMap,
} from './environment';
import {
  MICROBE_TEMPLATES,
  PLAYER_COLORS,
  createColonyProperties,
  generateColonyId,
  getSpreadRange,
  calculateEnvironmentFitness,
} from './microbes';
import {
  calculateMutationProbability,
  applyMutation,
  getRandomMutation,
  MUTATION_POOL,
} from './mutations';
import { v4 as uuidv4 } from 'uuid';
import { CustomMapData } from './types';

export const MAX_TURNS = 40;
export const INITIAL_BIOMASS = 50;
export const MAX_BIOMASS = 100;
export const NUTRIENT_CONSUMPTION_RATE = 0.005;
export const BIOMASS_RECOVERY_RATE = 0.02;
export const ANTIBIOTIC_DAMAGE_RATE = 0.05;
export const HIGH_TEMP_DAMAGE_THRESHOLD = 42;
export const LOW_TEMP_DAMAGE_THRESHOLD = 25;
export const VICTORY_AREA_PERCENTAGE = 0.60;

export function createGameState(
  players: Player[],
  customMap: CustomMapData | null = null
): GameState {
  const gridSize = GRID_SIZE;
  const grid = customMap
    ? createInitialGridFromCustomMap(gridSize, customMap)
    : createInitialGrid(gridSize);
  const colonies: Colony[] = [];
  const actualPlayers = players.filter((p) => !p.isSpectator);

  const startPositions = customMap
    ? getStartPositionsFromMap(actualPlayers.length, customMap)
    : getStartPositions(actualPlayers.length, gridSize);

  actualPlayers.forEach((player, index) => {
    const pos = startPositions[index];
    if (grid[pos.y]?.[pos.x]?.environment.terrain !== 'barrier') {
      const colony = createInitialColony(player, pos);
      colonies.push(colony);
      grid[pos.y][pos.x].colony = colony;
    }
  });

  const gameState: GameState = {
    id: 'game_' + uuidv4().slice(0, 8),
    status: 'playing',
    turn: 0,
    maxTurns: MAX_TURNS,
    gridSize,
    grid,
    players,
    colonies,
    globalEvents: [],
    eventLog: [
      {
        turn: 0,
        type: 'info',
        message: `游戏开始！${actualPlayers.length} 名玩家参与培养皿领地争夺战！`,
      },
    ],
    winnerId: null,
    rankings: [],
  };

  updatePlayerStats(gameState);
  return gameState;
}

function getStartPositions(count: number, gridSize: number): Position[] {
  const positions: Position[] = [];
  const center = (gridSize - 1) / 2;
  const radius = gridSize * 0.35;

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    let x = Math.floor(center + Math.cos(angle) * radius);
    let y = Math.floor(center + Math.sin(angle) * radius);

    if (!isInsideDish(x, y, gridSize)) {
      for (let shrink = 0.9; shrink > 0.3; shrink -= 0.05) {
        x = Math.floor(center + Math.cos(angle) * radius * shrink);
        y = Math.floor(center + Math.sin(angle) * radius * shrink);
        if (isInsideDish(x, y, gridSize)) break;
      }
    }

    positions.push({ x, y });
  }

  return positions;
}

function getStartPositionsFromMap(
  count: number,
  customMap: CustomMapData
): Position[] {
  const spawns = customMap.spawnPoints || [];
  const positions: Position[] = [];

  for (let i = 0; i < count; i++) {
    if (i < spawns.length) {
      positions.push({ ...spawns[i] });
    } else {
      positions.push(
        ...getStartPositions(count - positions.length, customMap.gridSize)
      );
      break;
    }
  }

  return positions;
}

function createInitialColony(player: Player, pos: Position): Colony {
  return {
    id: generateColonyId(),
    playerId: player.id,
    position: { ...pos },
    microbeType: player.microbeType,
    biomass: INITIAL_BIOMASS,
    maxBiomass: MAX_BIOMASS,
    biofilmLayers: 0,
    properties: createColonyProperties(player.microbeType),
    phageInjectionTurnsLeft: null,
    timesAttackedRecently: 0,
  };
}

export function createPlayer(
  id: string,
  name: string,
  microbeType: MicrobeType,
  isHost: boolean = false,
  isSpectator: boolean = false
): Player {
  const colorIndex = isSpectator
    ? 0
    : Math.floor(Math.random() * PLAYER_COLORS.length);

  return {
    id,
    name,
    microbeType,
    color: isSpectator ? '#888888' : PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
    isAlive: !isSpectator,
    isSpectator,
    isHost,
    hasSubmitted: false,
    totalArea: 0,
    weightedArea: 0,
  };
}

export function processTurn(
  gameState: GameState,
  actions: PlayerAction[]
): TurnResult {
  const turnEvents: EventLogEntry[] = [];
  const turnKills: KillEvent[] = [];
  gameState.turn++;

  phaseNutrientUptake(gameState, turnEvents);
  phaseToxinDamage(gameState, turnEvents);
  phasePhageInjectionResolution(gameState, turnEvents, turnKills);
  phaseReproductionAndSpread(gameState, actions, turnEvents, turnKills);
  phaseAttackResolution(gameState, actions, turnEvents, turnKills);
  phaseAntibioticDamage(gameState, turnEvents);
  phaseTemperatureDamage(gameState, turnEvents);
  phaseBiofilmRegeneration(gameState);
  phaseMutationEvents(gameState, turnEvents);
  phaseGlobalEvents(gameState, turnEvents);
  phaseEnvironmentUpdate(gameState);
  phaseDeadColonyCleanup(gameState, turnEvents);
  phasePlayerEliminationCheck(gameState, turnEvents);
  phaseStatUpdate(gameState);

  const victoryResult = checkVictoryCondition(gameState, turnEvents);
  if (victoryResult) {
    gameState.status = 'finished';
  }

  return { events: turnEvents, kills: turnKills };
}

function phaseToxinDamage(
  gameState: GameState,
  events: EventLogEntry[]
) {
  const TOXIN_DAMAGE = 2;
  for (const colony of gameState.colonies) {
    const cell = gameState.grid[colony.position.y][colony.position.x];
    if (cell.environment.terrain === 'toxin') {
      colony.biomass = Math.max(0, colony.biomass - TOXIN_DAMAGE);
    }
  }
}

function phaseNutrientUptake(
  gameState: GameState,
  events: EventLogEntry[]
) {
  for (const colony of gameState.colonies) {
    const cell = gameState.grid[colony.position.y][colony.position.x];
    const nutrient = cell.environment.nutrient;

    if (nutrient > 0.05) {
      const consumption = Math.min(
        nutrient * NUTRIENT_CONSUMPTION_RATE * colony.biomass,
        nutrient * 0.1
      );
      cell.environment.nutrient = Math.max(0, cell.environment.nutrient - consumption);

      if (colony.biomass < colony.maxBiomass) {
        const recovery =
          consumption * BIOMASS_RECOVERY_RATE * 10 * colony.properties.reproductionRate;
        colony.biomass = Math.min(colony.maxBiomass, colony.biomass + recovery);
      }
    } else if (nutrient < 0.02) {
      const starvationDamage = 2;
      colony.biomass = Math.max(0, colony.biomass - starvationDamage);
    }
  }
}

function phasePhageInjectionResolution(
  gameState: GameState,
  events: EventLogEntry[],
  kills: KillEvent[]
) {
  for (const colony of gameState.colonies) {
    if (colony.phageInjectionTurnsLeft !== null) {
      colony.phageInjectionTurnsLeft--;
      if (colony.phageInjectionTurnsLeft <= 0) {
        const victimId = colony.playerId;
        const colonyId = colony.id;
        colony.biomass = 0;
        events.push({
          turn: gameState.turn,
          type: 'attack',
          message: `玩家 ${getPlayerName(gameState, colony.playerId)} 的一个菌落因噬菌体注入而死亡！`,
          playerId: colony.playerId,
          victimId: victimId,
        });
        kills.push({
          turn: gameState.turn,
          attackerPlayerId: 'phage',
          victimPlayerId: victimId,
          colonyId: colonyId,
        });
        colony.phageInjectionTurnsLeft = null;
      }
    }
  }
}

function phaseReproductionAndSpread(
  gameState: GameState,
  actions: PlayerAction[],
  events: EventLogEntry[],
  kills: KillEvent[]
) {
  const spreadActions = actions.filter((a) => a.actionType === 'spread');
  const pendingSpreads: Array<{
    colony: Colony;
    targetPos: Position;
    isPlayerAction: boolean;
  }> = [];

  for (const colony of gameState.colonies) {
    if (colony.biomass <= 0) continue;

    const playerAction = spreadActions.find(
      (a) => a.colonyId === colony.id && a.playerId === colony.playerId
    );

    if (playerAction && playerAction.targetPosition) {
      pendingSpreads.push({
        colony,
        targetPos: playerAction.targetPosition,
        isPlayerAction: true,
      });
    }

    if (colony.biomass >= colony.maxBiomass * 0.6 && Math.random() < colony.properties.reproductionRate * 0.3) {
      const autoTargets = getChemotaxisTargets(gameState, colony);
      if (autoTargets.length > 0) {
        const target = autoTargets[Math.floor(Math.random() * autoTargets.length)];
        pendingSpreads.push({
          colony,
          targetPos: target,
          isPlayerAction: false,
        });
      }
    }
  }

  resolveSpreadAttempts(gameState, pendingSpreads, events, kills);
}

function getChemotaxisTargets(
  gameState: GameState,
  colony: Colony
): Position[] {
  const { min, max } = getSpreadRange(colony.properties.spreadMode);
  const candidates: Array<{ pos: Position; score: number }> = [];

  for (let dy = -max; dy <= max; dy++) {
    for (let dx = -max; dx <= max; dx++) {
      if (dx === 0 && dy === 0) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < min - 0.5 || dist > max + 0.5) continue;

      const nx = colony.position.x + dx;
      const ny = colony.position.y + dy;
      if (nx < 0 || nx >= gameState.gridSize || ny < 0 || ny >= gameState.gridSize) continue;
      if (!isInsideDish(nx, ny, gameState.gridSize)) continue;

      const cell = gameState.grid[ny][nx];
      if (cell.environment.terrain === 'barrier') continue;
      let score = cell.environment.nutrient * 10;

      const fit = calculateEnvironmentFitness(
        colony.microbeType,
        cell.environment.temperature,
        cell.environment.pH
      );
      score *= fit;

      const hasAbx = Object.keys(cell.environment.antibiotics).length > 0;
      if (hasAbx) {
        for (const [atype, level] of Object.entries(cell.environment.antibiotics) as [
          AntibioticType,
          number
        ][]) {
          if (!colony.properties.antibioticResistance[atype]) {
            score -= level * 20;
          }
        }
      }

      if (cell.colony && cell.colony.playerId === colony.playerId) {
        score *= 0.3;
      }

      candidates.push({ pos: { x: nx, y: ny }, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 3).map((c) => c.pos);
}

function resolveSpreadAttempts(
  gameState: GameState,
  attempts: Array<{
    colony: Colony;
    targetPos: Position;
    isPlayerAction: boolean;
  }>,
  events: EventLogEntry[],
  kills: KillEvent[]
) {
  const cellContestMap = new Map<string, Colony[]>();

  for (const attempt of attempts) {
    const tx = attempt.targetPos.x;
    const ty = attempt.targetPos.y;
    const targetCell = gameState.grid[ty]?.[tx];
    if (!targetCell) continue;
    if (targetCell.environment.terrain === 'barrier') continue;

    const key = `${tx},${ty}`;
    if (!cellContestMap.has(key)) {
      cellContestMap.set(key, []);
    }
    cellContestMap.get(key)!.push(attempt.colony);
  }

  for (const [key, contestants] of cellContestMap) {
    const [tx, ty] = key.split(',').map(Number);
    const targetCell = gameState.grid[ty][tx];

    const uniqueContestants: Colony[] = [];
    const seenIds = new Set<string>();
    for (const c of contestants) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        uniqueContestants.push(c);
      }
    }

    if (targetCell.colony) {
      if (targetCell.colony.playerId === uniqueContestants[0]?.playerId && uniqueContestants.length === 1) {
        continue;
      }
      uniqueContestants.push(targetCell.colony);
    }

    if (uniqueContestants.length === 1) {
      const only = uniqueContestants[0];
      if (!targetCell.colony || targetCell.colony.playerId !== only.playerId) {
        createOffspringColony(gameState, only, targetCell, events);
      }
    } else if (uniqueContestants.length === 2) {
      resolveTwoWayCompetition(gameState, uniqueContestants[0], uniqueContestants[1], targetCell, events, kills);
    } else if (uniqueContestants.length >= 3) {
      resolveMultiWayCompetition(gameState, uniqueContestants.slice(0, 3), targetCell, events, kills);
    }
  }
}

function createOffspringColony(
  gameState: GameState,
  parent: Colony,
  targetCell: Cell,
  events: EventLogEntry[]
) {
  if (!isInsideDish(targetCell.position.x, targetCell.position.y, gameState.gridSize)) {
    return;
  }

  const offspringBiomass = parent.biomass * 0.4;
  if (offspringBiomass < 10) return;

  const isConjugation = parent.properties.spreadMode === 'conjugation';
  const hasEnemyColony =
    targetCell.colony !== null && targetCell.colony.playerId !== parent.playerId;

  if (isConjugation && hasEnemyColony) {
    const enemy = targetCell.colony!;
    const transferChance = Math.min(0.5, offspringBiomass / 100);
    if (Math.random() < transferChance && parent.properties.mutations.length > 0) {
      const mutId = parent.properties.mutations[
        Math.floor(Math.random() * parent.properties.mutations.length)
      ];
      if (!enemy.properties.mutations.includes(mutId)) {
        const templateMutation = MUTATION_POOL.find((m) => m.id === mutId);
        if (templateMutation) {
          applyMutation(enemy, templateMutation);
          events.push({
            turn: gameState.turn,
            type: 'mutation',
            message: `接合转移发生！${getPlayerName(gameState, parent.playerId)} 将突变基因传递给了 ${getPlayerName(gameState, enemy.playerId)}！`,
            playerId: parent.playerId,
          });
        }
      }
    }
    parent.biomass -= offspringBiomass;
    return;
  }

  if (targetCell.colony) {
    return;
  }

  parent.biomass -= offspringBiomass;

  const offspring: Colony = {
    id: generateColonyId(),
    playerId: parent.playerId,
    position: { ...targetCell.position },
    microbeType: parent.microbeType,
    biomass: offspringBiomass,
    maxBiomass: parent.maxBiomass,
    biofilmLayers: 0,
    properties: JSON.parse(JSON.stringify(parent.properties)),
    phageInjectionTurnsLeft: null,
    timesAttackedRecently: 0,
  };

  if (parent.microbeType !== 'phage') {
    gameState.colonies.push(offspring);
    targetCell.colony = offspring;
  } else {
    phageAttemptInjection(gameState, parent, targetCell, offspringBiomass, events);
  }
}

function resolveTwoWayCompetition(
  gameState: GameState,
  c1: Colony,
  c2: Colony,
  cell: Cell,
  events: EventLogEntry[],
  kills: KillEvent[]
) {
  const p1 = getPlayer(gameState, c1.playerId);
  const p2 = getPlayer(gameState, c2.playerId);

  if (c1.playerId === c2.playerId) {
    if (!cell.colony) {
      createOffspringColony(gameState, c1, cell, events);
    }
    return;
  }

  if (c1.microbeType === 'phage' && c2.playerId !== c1.playerId && cell.colony === c2) {
    phageAttemptInjection(gameState, c1, cell, c1.biomass * 0.3, events);
    c1.biomass *= 0.7;
    return;
  }
  if (c2.microbeType === 'phage' && c1.playerId !== c2.playerId && cell.colony === c1) {
    phageAttemptInjection(gameState, c2, cell, c2.biomass * 0.3, events);
    c2.biomass *= 0.7;
    return;
  }

  const fit1 = calculateEnvironmentFitness(
    c1.microbeType,
    cell.environment.temperature,
    cell.environment.pH
  );
  const fit2 = calculateEnvironmentFitness(
    c2.microbeType,
    cell.environment.temperature,
    cell.environment.pH
  );

  const comp1 = c1.properties.attackPower * c1.biomass * fit1;
  const comp2 = c2.properties.attackPower * c2.biomass * fit2;

  if (comp1 >= comp2 * 3) {
    const biomassLoss = c2.biomass;
    const c2Id = c2.id;
    const c2Owner = c2.playerId;
    c2.biomass = 0;
    c1.biomass *= 0.7;
    events.push({
      turn: gameState.turn,
      type: 'attack',
      message: `${p1?.name || c1.playerId} 的菌落压倒性击败了 ${p2?.name || c2.playerId}！`,
      playerId: c1.playerId,
      attackerId: c1.playerId,
      victimId: c2Owner,
    });
    kills.push({
      turn: gameState.turn,
      attackerPlayerId: c1.playerId,
      victimPlayerId: c2Owner,
      colonyId: c2Id,
    });
    if (cell.colony === c2) {
      cell.colony = null;
      const newBiomass = c1.biomass * 0.3;
      c1.biomass -= newBiomass;
      if (newBiomass >= 10) {
        const offspring: Colony = {
          id: generateColonyId(),
          playerId: c1.playerId,
          position: { ...cell.position },
          microbeType: c1.microbeType,
          biomass: newBiomass,
          maxBiomass: c1.maxBiomass,
          biofilmLayers: 0,
          properties: JSON.parse(JSON.stringify(c1.properties)),
          phageInjectionTurnsLeft: null,
          timesAttackedRecently: 0,
        };
        gameState.colonies.push(offspring);
        cell.colony = offspring;
      }
    }
  } else if (comp2 >= comp1 * 3) {
    const biomassLoss = c1.biomass;
    const c1Id = c1.id;
    const c1Owner = c1.playerId;
    c1.biomass = 0;
    c2.biomass *= 0.7;
    events.push({
      turn: gameState.turn,
      type: 'attack',
      message: `${p2?.name || c2.playerId} 的菌落压倒性击败了 ${p1?.name || c1.playerId}！`,
      playerId: c2.playerId,
      attackerId: c2.playerId,
      victimId: c1Owner,
    });
    kills.push({
      turn: gameState.turn,
      attackerPlayerId: c2.playerId,
      victimPlayerId: c1Owner,
      colonyId: c1Id,
    });
    if (cell.colony === c1) {
      cell.colony = null;
      const newBiomass = c2.biomass * 0.3;
      c2.biomass -= newBiomass;
      if (newBiomass >= 10) {
        const offspring: Colony = {
          id: generateColonyId(),
          playerId: c2.playerId,
          position: { ...cell.position },
          microbeType: c2.microbeType,
          biomass: newBiomass,
          maxBiomass: c2.maxBiomass,
          biofilmLayers: 0,
          properties: JSON.parse(JSON.stringify(c2.properties)),
          phageInjectionTurnsLeft: null,
          timesAttackedRecently: 0,
        };
        gameState.colonies.push(offspring);
        cell.colony = offspring;
      }
    }
  } else {
    const totalComp = comp1 + comp2;
    const ratio1 = comp1 / totalComp;
    const ratio2 = comp2 / totalComp;

    const damageTo2 = c2.biomass * (1 - ratio2) * 0.5;
    const damageTo1 = c1.biomass * (1 - ratio1) * 0.5;

    let actualDamage2 = damageTo2;
    if (c2.biofilmLayers > 0) {
      const blocked = Math.min(c2.biofilmLayers * 10, actualDamage2);
      actualDamage2 -= blocked;
      c2.biofilmLayers = Math.max(0, c2.biofilmLayers - Math.ceil(blocked / 10));
    }

    let actualDamage1 = damageTo1;
    if (c1.biofilmLayers > 0) {
      const blocked = Math.min(c1.biofilmLayers * 10, actualDamage1);
      actualDamage1 -= blocked;
      c1.biofilmLayers = Math.max(0, c1.biofilmLayers - Math.ceil(blocked / 10));
    }

    c1.biomass = Math.max(0, c1.biomass - actualDamage1);
    c2.biomass = Math.max(0, c2.biomass - actualDamage2);
    c1.timesAttackedRecently++;
    c2.timesAttackedRecently++;

    if (comp1 > comp2 && cell.colony && cell.colony !== c1) {
      if (c2.biomass <= 0 || c1.biomass > c2.biomass * 1.5) {
        if (!cell.colony || cell.colony.biomass <= 0) {
          cell.colony = null;
          if (c1.biomass * 0.3 >= 10) {
            const newBiomass = c1.biomass * 0.3;
            c1.biomass -= newBiomass;
            const offspring: Colony = {
              id: generateColonyId(),
              playerId: c1.playerId,
              position: { ...cell.position },
              microbeType: c1.microbeType,
              biomass: newBiomass,
              maxBiomass: c1.maxBiomass,
              biofilmLayers: 0,
              properties: JSON.parse(JSON.stringify(c1.properties)),
              phageInjectionTurnsLeft: null,
              timesAttackedRecently: 0,
            };
            gameState.colonies.push(offspring);
            cell.colony = offspring;
          }
        }
      }
    } else if (comp2 > comp1 && cell.colony && cell.colony !== c2) {
      if (c1.biomass <= 0 || c2.biomass > c1.biomass * 1.5) {
        if (!cell.colony || cell.colony.biomass <= 0) {
          cell.colony = null;
          if (c2.biomass * 0.3 >= 10) {
            const newBiomass = c2.biomass * 0.3;
            c2.biomass -= newBiomass;
            const offspring: Colony = {
              id: generateColonyId(),
              playerId: c2.playerId,
              position: { ...cell.position },
              microbeType: c2.microbeType,
              biomass: newBiomass,
              maxBiomass: c2.maxBiomass,
              biofilmLayers: 0,
              properties: JSON.parse(JSON.stringify(c2.properties)),
              phageInjectionTurnsLeft: null,
              timesAttackedRecently: 0,
            };
            gameState.colonies.push(offspring);
            cell.colony = offspring;
          }
        }
      }
    }
  }
}

function resolveMultiWayCompetition(
  gameState: GameState,
  contestants: Colony[],
  cell: Cell,
  events: EventLogEntry[],
  kills: KillEvent[]
) {
  for (let i = 0; i < contestants.length; i++) {
    for (let j = i + 1; j < contestants.length; j++) {
      if (contestants[i].playerId !== contestants[j].playerId) {
        const mutualDamage = Math.min(contestants[i].biomass, contestants[j].biomass) * 0.2;
        contestants[i].biomass = Math.max(0, contestants[i].biomass - mutualDamage);
        contestants[j].biomass = Math.max(0, contestants[j].biomass - mutualDamage);
        contestants[i].timesAttackedRecently++;
        contestants[j].timesAttackedRecently++;
      }
    }
  }

  let maxBiomass = -1;
  let winner: Colony | null = null;
  for (const c of contestants) {
    if (c.biomass > maxBiomass) {
      maxBiomass = c.biomass;
      winner = c;
    }
  }

  if (winner && maxBiomass >= 15) {
    if (!cell.colony || cell.colony.biomass <= 0) {
      cell.colony = null;
      const newBiomass = winner.biomass * 0.2;
      winner.biomass -= newBiomass;
      if (newBiomass >= 10) {
        const offspring: Colony = {
          id: generateColonyId(),
          playerId: winner.playerId,
          position: { ...cell.position },
          microbeType: winner.microbeType,
          biomass: newBiomass,
          maxBiomass: winner.maxBiomass,
          biofilmLayers: 0,
          properties: JSON.parse(JSON.stringify(winner.properties)),
          phageInjectionTurnsLeft: null,
          timesAttackedRecently: 0,
        };
        gameState.colonies.push(offspring);
        cell.colony = offspring;
      }
    }
    events.push({
      turn: gameState.turn,
      type: 'attack',
      message: `三方争夺！${getPlayerName(gameState, winner.playerId)} 渔翁得利！`,
      playerId: winner.playerId,
    });
  }
}

function phageAttemptInjection(
  gameState: GameState,
  phage: Colony,
  targetCell: Cell,
  strength: number,
  events: EventLogEntry[]
) {
  if (!targetCell.colony || targetCell.colony.playerId === phage.playerId) {
    return;
  }

  const target = targetCell.colony;
  if (target.phageInjectionTurnsLeft !== null) {
    return;
  }

  const injectionChance = Math.min(0.9, strength / 50);
  if (Math.random() < injectionChance) {
    target.phageInjectionTurnsLeft = 3;
    events.push({
      turn: gameState.turn,
      type: 'attack',
      message: `噬菌体感染！${getPlayerName(gameState, target.playerId)} 的一个菌落被注入，3回合后死亡！`,
      playerId: phage.playerId,
    });
  }
}

function phaseAttackResolution(
  gameState: GameState,
  actions: PlayerAction[],
  events: EventLogEntry[],
  kills: KillEvent[]
) {
  const attackActions = actions.filter(
    (a) => a.actionType === 'attack' && a.colonyId && a.targetPosition
  );

  for (const action of attackActions) {
    const attackerColony = gameState.colonies.find((c) => c.id === action.colonyId);
    if (!attackerColony || attackerColony.biomass <= 0) continue;
    if (attackerColony.playerId !== action.playerId) continue;

    const target = action.targetPosition!;
    if (target.x < 0 || target.x >= gameState.gridSize || target.y < 0 || target.y >= gameState.gridSize) continue;

    const targetCell = gameState.grid[target.y][target.x];
    if (targetCell.environment.terrain === 'barrier') continue;

    const dist = Math.sqrt(
      Math.pow(target.x - attackerColony.position.x, 2) +
        Math.pow(target.y - attackerColony.position.y, 2)
    );

    if (dist > 2) continue;

    executeAttack(gameState, attackerColony, targetCell, events, kills);
  }

  for (const colony of gameState.colonies) {
    if (colony.biomass <= 0) continue;
    if (colony.properties.attackType === 'nutrient_competition') {
      drainSurroundingNutrients(gameState, colony);
    } else if (colony.properties.attackType === 'toxin' && colony.biomass >= colony.maxBiomass * 0.7) {
      if (Math.random() < 0.15) {
        aoeToxinAttack(gameState, colony, events, kills);
      }
    }
  }
}

function executeAttack(
  gameState: GameState,
  attacker: Colony,
  targetCell: Cell,
  events: EventLogEntry[],
  kills: KillEvent[]
) {
  if (!targetCell.colony) return;
  if (targetCell.colony.playerId === attacker.playerId) return;

  const defender = targetCell.colony;

  switch (attacker.properties.attackType) {
    case 'toxin': {
      aoeToxinAttack(gameState, attacker, events, kills);
      break;
    }
    case 'lysozyme': {
      singleTargetAttack(gameState, attacker, defender, events, kills);
      break;
    }
    case 'phage_injection': {
      phageAttemptInjection(gameState, attacker, targetCell, attacker.biomass * 0.5, events);
      attacker.biomass *= 0.8;
      break;
    }
    case 'nutrient_competition': {
      drainSurroundingNutrients(gameState, attacker);
      break;
    }
  }
}

function aoeToxinAttack(
  gameState: GameState,
  attacker: Colony,
  events: EventLogEntry[],
  kills: KillEvent[]
) {
  const p = getPlayer(gameState, attacker.playerId);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = attacker.position.x + dx;
      const ny = attacker.position.y + dy;
      if (nx < 0 || nx >= gameState.gridSize || ny < 0 || ny >= gameState.gridSize) continue;

      const cell = gameState.grid[ny][nx];
      if (cell.environment.terrain === 'barrier') continue;
      if (!cell.colony || cell.colony.playerId === attacker.playerId) continue;

      const defender = cell.colony;
      const prevBiomass = defender.biomass;
      const defenderId = defender.id;
      const defenderOwner = defender.playerId;
      let damage = attacker.properties.attackPower * (attacker.biomass / 50) * 0.6;

      if (defender.biofilmLayers > 0) {
        const blocked = Math.min(defender.biofilmLayers * 8, damage);
        damage -= blocked;
        defender.biofilmLayers = Math.max(0, defender.biofilmLayers - 1);
      }

      defender.biomass = Math.max(0, defender.biomass - damage);
      defender.timesAttackedRecently++;

      if (prevBiomass > 0 && defender.biomass <= 0) {
        events.push({
          turn: gameState.turn,
          type: 'attack',
          message: `${p?.name || attacker.playerId} 的毒素攻击消灭了一个敌方菌落！`,
          playerId: attacker.playerId,
          attackerId: attacker.playerId,
          victimId: defenderOwner,
        });
        kills.push({
          turn: gameState.turn,
          attackerPlayerId: attacker.playerId,
          victimPlayerId: defenderOwner,
          colonyId: defenderId,
        });
      }
    }
  }

  attacker.biomass = Math.max(0, attacker.biomass - 5);
}

function singleTargetAttack(
  gameState: GameState,
  attacker: Colony,
  defender: Colony,
  events: EventLogEntry[],
  kills: KillEvent[]
) {
  const prevBiomass = defender.biomass;
  const defenderId = defender.id;
  const defenderOwner = defender.playerId;
  let damage = attacker.properties.attackPower * (attacker.biomass / 50) * 1.5;

  const fit = calculateEnvironmentFitness(
    attacker.microbeType,
    gameState.grid[defender.position.y][defender.position.x].environment.temperature,
    gameState.grid[defender.position.y][defender.position.x].environment.pH
  );
  damage *= fit;

  if (attacker.microbeType === 'protozoa' && defender.biomass < attacker.biomass * 0.6) {
    damage *= 1.5;
  }

  if (defender.biofilmLayers > 0) {
    const layersNeeded = Math.ceil(damage / 15);
    const usedLayers = Math.min(defender.biofilmLayers, layersNeeded);
    damage -= usedLayers * 15;
    defender.biofilmLayers -= usedLayers;
  }

  damage /= defender.properties.defenseCoefficient;
  damage = Math.max(0, damage);

  defender.biomass = Math.max(0, defender.biomass - damage);
  defender.timesAttackedRecently++;

  if (attacker.microbeType === 'protozoa' && defender.biomass <= 0) {
    const gained = Math.min(attacker.maxBiomass * 0.3, 20);
    attacker.biomass = Math.min(attacker.maxBiomass, attacker.biomass + gained);
    events.push({
      turn: gameState.turn,
      type: 'attack',
      message: `${getPlayerName(gameState, attacker.playerId)} 的原生动物吞噬了一个敌方菌落！`,
      playerId: attacker.playerId,
      attackerId: attacker.playerId,
      victimId: defenderOwner,
    });
  }

  if (prevBiomass > 0 && defender.biomass <= 0) {
    kills.push({
      turn: gameState.turn,
      attackerPlayerId: attacker.playerId,
      victimPlayerId: defenderOwner,
      colonyId: defenderId,
    });
  }

  attacker.biomass = Math.max(0, attacker.biomass - 3);
}

function drainSurroundingNutrients(gameState: GameState, colony: Colony) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = colony.position.x + dx;
      const ny = colony.position.y + dy;
      if (nx < 0 || nx >= gameState.gridSize || ny < 0 || ny >= gameState.gridSize) continue;

      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 2) continue;

      const cell = gameState.grid[ny][nx];
      if (cell.environment.terrain === 'barrier') continue;
      const drainAmount = cell.environment.nutrient * 0.05 * (1 - dist / 3);
      cell.environment.nutrient = Math.max(0, cell.environment.nutrient - drainAmount);
    }
  }
}

function phaseAntibioticDamage(
  gameState: GameState,
  events: EventLogEntry[]
) {
  for (const colony of gameState.colonies) {
    if (colony.biomass <= 0) continue;
    const cell = gameState.grid[colony.position.y][colony.position.x];
    for (const [atype, level] of Object.entries(cell.environment.antibiotics) as [
      AntibioticType,
      number
    ][]) {
      if (!colony.properties.antibioticResistance[atype]) {
        const damage = level * ANTIBIOTIC_DAMAGE_RATE * colony.biomass * 20;
        colony.biomass = Math.max(0, colony.biomass - damage);
      }
    }
  }
}

function phaseTemperatureDamage(
  gameState: GameState,
  events: EventLogEntry[]
) {
  for (const colony of gameState.colonies) {
    if (colony.biomass <= 0) continue;
    const cell = gameState.grid[colony.position.y][colony.position.x];
    const temp = cell.environment.temperature;

    if (temp > HIGH_TEMP_DAMAGE_THRESHOLD) {
      const excess = temp - HIGH_TEMP_DAMAGE_THRESHOLD;
      const damage = excess * 0.02 * colony.biomass;
      colony.biomass = Math.max(0, colony.biomass - damage);
    } else if (temp < LOW_TEMP_DAMAGE_THRESHOLD) {
      const deficit = LOW_TEMP_DAMAGE_THRESHOLD - temp;
      const damage = deficit * 0.01 * colony.biomass;
      colony.biomass = Math.max(0, colony.biomass - damage);
    }
  }
}

function phaseBiofilmRegeneration(gameState: GameState) {
  for (const colony of gameState.colonies) {
    if (colony.biomass <= 0) continue;
    const targetLayers = colony.properties.biofilmStrength;
    if (colony.biofilmLayers < targetLayers && colony.biomass > colony.maxBiomass * 0.4) {
      if (Math.random() < 0.2) {
        colony.biofilmLayers = Math.min(targetLayers, colony.biofilmLayers + 1);
      }
    }
  }
}

function phaseMutationEvents(
  gameState: GameState,
  events: EventLogEntry[]
) {
  for (const colony of gameState.colonies) {
    if (colony.biomass <= 0) continue;

    const cell = gameState.grid[colony.position.y][colony.position.x];
    const inAntibioticZone = Object.keys(cell.environment.antibiotics).length > 0 &&
      !Object.entries(cell.environment.antibiotics).every(
        ([atype]) => colony.properties.antibioticResistance[atype as AntibioticType]
      );

    const prob = calculateMutationProbability(
      colony,
      inAntibioticZone,
      colony.timesAttackedRecently
    );

    if (Math.random() < prob) {
      const mutation = getRandomMutation(colony);
      if (mutation) {
        applyMutation(colony, mutation);
        const p = getPlayer(gameState, colony.playerId);
        events.push({
          turn: gameState.turn,
          type: 'mutation',
          message: `🧬 ${p?.name || colony.playerId} 发生突变：${mutation.name}！`,
          playerId: colony.playerId,
        });
      }
    }

    colony.timesAttackedRecently = Math.max(0, colony.timesAttackedRecently - 1);
  }
}

function phaseGlobalEvents(
  gameState: GameState,
  events: EventLogEntry[]
) {
  const globalEvent = triggerGlobalEvent(gameState);
  if (globalEvent) {
    gameState.globalEvents.push(globalEvent);
    events.push({
      turn: gameState.turn,
      type: 'event',
      message: `🌍 第${gameState.turn}回合事件：${globalEvent.description}`,
    });
  }
}

function phaseEnvironmentUpdate(gameState: GameState) {
  regenerateNutrients(gameState.grid, gameState.gridSize);
  perturbEnvironment(gameState.grid, gameState.gridSize);
}

function phaseDeadColonyCleanup(
  gameState: GameState,
  events: EventLogEntry[]
) {
  const deadColonies = gameState.colonies.filter((c) => c.biomass <= 0);

  for (const dead of deadColonies) {
    const cell = gameState.grid[dead.position.y][dead.position.x];
    if (cell.colony === dead) {
      cell.colony = null;
      cell.environment.nutrient = Math.min(
        cell.environment.maxNutrient,
        cell.environment.nutrient + 0.1
      );
    }
  }

  gameState.colonies = gameState.colonies.filter((c) => c.biomass > 0);

  const uniqueColors = new Set<string>();
  const colorUsage = new Map<string, number>();
  for (const p of gameState.players) {
    if (!p.isSpectator) {
      colorUsage.set(p.color, (colorUsage.get(p.color) || 0) + 1);
    }
  }
}

function phasePlayerEliminationCheck(
  gameState: GameState,
  events: EventLogEntry[]
) {
  for (const player of gameState.players) {
    if (player.isSpectator || !player.isAlive) continue;
    const playerColonies = gameState.colonies.filter((c) => c.playerId === player.id);
    if (playerColonies.length === 0) {
      player.isAlive = false;
      events.push({
        turn: gameState.turn,
        type: 'elimination',
        message: `💀 ${player.name} 被淘汰了！菌落全部死亡，转为观战模式`,
        playerId: player.id,
      });
      player.isSpectator = true;
    }
  }
}

function phaseStatUpdate(gameState: GameState) {
  updatePlayerStats(gameState);
}

function updatePlayerStats(gameState: GameState) {
  let totalWeightedArea = 0;

  for (const player of gameState.players) {
    if (player.isSpectator) {
      player.totalArea = 0;
      player.weightedArea = 0;
      continue;
    }

    let area = 0;
    let weighted = 0;
    for (const colony of gameState.colonies) {
      if (colony.playerId === player.id) {
        area++;
        weighted += colony.biomass / colony.maxBiomass;
      }
    }
    player.totalArea = area;
    player.weightedArea = weighted;
    totalWeightedArea += weighted;
  }

  gameState.rankings = gameState.players
    .filter((p) => !p.isSpectator || p.isAlive === false)
    .map((p) => ({
      playerId: p.id,
      area: p.totalArea,
      weightedArea: p.weightedArea,
    }))
    .sort((a, b) => b.weightedArea - a.weightedArea);
}

function checkVictoryCondition(
  gameState: GameState,
  events: EventLogEntry[]
): boolean {
  const alivePlayers = gameState.players.filter((p) => p.isAlive && !p.isSpectator);
  const totalDishCells = getDishCellCount(gameState.gridSize);

  for (const player of alivePlayers) {
    if (player.totalArea / totalDishCells >= VICTORY_AREA_PERCENTAGE) {
      gameState.winnerId = player.id;
      const percent = Math.round((player.totalArea / totalDishCells) * 100);
      events.push({
        turn: gameState.turn,
        type: 'victory',
        message: `🏆 ${player.name} 提前胜利！控制了全场 ${percent}% 的领地！`,
        playerId: player.id,
      });
      return true;
    }
  }

  if (alivePlayers.length <= 1) {
    if (alivePlayers.length === 1) {
      gameState.winnerId = alivePlayers[0].id;
      events.push({
        turn: gameState.turn,
        type: 'victory',
        message: `🏆 ${alivePlayers[0].name} 获得最终胜利！所有对手已被淘汰！`,
        playerId: alivePlayers[0].id,
      });
    }
    return true;
  }

  if (gameState.turn >= MAX_TURNS) {
    const sorted = [...alivePlayers].sort(
      (a, b) => b.weightedArea - a.weightedArea
    );
    if (sorted.length > 0) {
      gameState.winnerId = sorted[0].id;
      events.push({
        turn: gameState.turn,
        type: 'victory',
        message: `⏰ ${MAX_TURNS}回合结束！${sorted[0].name} 以最大加权领地面积获胜！`,
        playerId: sorted[0].id,
      });
    }
    return true;
  }

  return false;
}

function getPlayer(gameState: GameState, playerId: string): Player | undefined {
  return gameState.players.find((p) => p.id === playerId);
}

function getPlayerName(gameState: GameState, playerId: string): string {
  const p = getPlayer(gameState, playerId);
  return p?.name || playerId;
}
