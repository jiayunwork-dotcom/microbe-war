import {
  ReplayData,
  ReplayListItem,
  GameState,
  Cell,
  Colony,
  PlayerAction,
  EventLogEntry,
  ChatMessage,
  TacticalMarker,
  Alliance,
  PlayerStats,
  GameStats,
  TurnAction,
  AllianceEvent,
  TurnSnapshot,
  Player,
} from '../game/types';
import { v4 as uuidv4 } from 'uuid';

const MAX_REPLAYS = 20;

interface PendingReplay {
  replayId: string;
  roomId: string;
  roomName: string;
  startTime: number;
  initialGameState: GameState;
  turnSnapshots: TurnSnapshot[];
  turnActions: TurnAction[];
  turnEvents: EventLogEntry[][];
  allianceEvents: AllianceEvent[];
  chatMessages: ChatMessage[];
  markers: TacticalMarker[][];
  previousColonyOwners: Map<string, string>;
  playerStatTrackers: Map<string, {
    spreadCount: number;
    attackCount: number;
    evolveCount: number;
    kills: number;
    deaths: number;
    maxArea: number;
    eliminatedTurn: number | null;
    allianceCount: number;
    betrayalCount: number;
  }>;
  turnKillCounts: Map<number, number>;
  areaHistory: Array<{ turn: number; areas: Record<string, number> }>;
}

export class ReplayManager {
  private replays: Map<string, ReplayData> = new Map();
  private replayList: ReplayListItem[] = [];
  private pendingReplays: Map<string, PendingReplay> = new Map();

  recordKill(roomId: string, attackerPlayerId: string, victimPlayerId: string): void {
    const pending = this.pendingReplays.get(roomId);
    if (!pending) return;

    const attackerTracker = pending.playerStatTrackers.get(attackerPlayerId);
    const victimTracker = pending.playerStatTrackers.get(victimPlayerId);

    if (attackerTracker) {
      attackerTracker.kills++;
    }
    if (victimTracker) {
      victimTracker.deaths++;
    }
  }

  startRecording(roomId: string, roomName: string, gameState: GameState): void {
    const replayId = 'replay_' + uuidv4().slice(0, 8);

    const statTrackers = new Map<string, {
      spreadCount: number;
      attackCount: number;
      evolveCount: number;
      kills: number;
      deaths: number;
      maxArea: number;
      eliminatedTurn: number | null;
      allianceCount: number;
      betrayalCount: number;
    }>();

    for (const player of gameState.players) {
      if (!player.isSpectator) {
        statTrackers.set(player.id, {
          spreadCount: 0,
          attackCount: 0,
          evolveCount: 0,
          kills: 0,
          deaths: 0,
          maxArea: player.totalArea,
          eliminatedTurn: null,
          allianceCount: 0,
          betrayalCount: 0,
        });
      }
    }

    const pending: PendingReplay = {
      replayId,
      roomId,
      roomName,
      startTime: Date.now(),
      initialGameState: JSON.parse(JSON.stringify(gameState)),
      turnSnapshots: [],
      turnActions: [],
      turnEvents: [],
      allianceEvents: [],
      chatMessages: [],
      markers: [],
      previousColonyOwners: new Map(),
      playerStatTrackers: statTrackers,
      turnKillCounts: new Map(),
      areaHistory: [],
    };

    for (const colony of gameState.colonies) {
      pending.previousColonyOwners.set(colony.id, colony.playerId);
    }

    this.pendingReplays.set(roomId, pending);
    this.recordTurnSnapshot(roomId, gameState, []);
  }

  recordTurnSnapshot(
    roomId: string,
    gameState: GameState,
    actions: PlayerAction[]
  ): void {
    const pending = this.pendingReplays.get(roomId);
    if (!pending) return;

    const currentTurn = gameState.turn;

    for (const action of actions) {
      const tracker = pending.playerStatTrackers.get(action.playerId);
      if (tracker) {
        if (action.actionType === 'spread') tracker.spreadCount++;
        else if (action.actionType === 'attack') tracker.attackCount++;
        else if (action.actionType === 'evolve') tracker.evolveCount++;
      }

      pending.turnActions.push({
        turn: currentTurn,
        playerId: action.playerId,
        actionType: action.actionType,
        colonyId: action.colonyId,
        targetPosition: action.targetPosition,
      });
    }

    const gridSnapshot: Cell[][] = JSON.parse(JSON.stringify(gameState.grid));
    const colonies: Colony[] = JSON.parse(JSON.stringify(gameState.colonies));

    const currentOwners = new Map<string, string>();
    for (const colony of colonies) {
      currentOwners.set(colony.id, colony.playerId);
    }

    pending.previousColonyOwners.clear();
    for (const [id, owner] of currentOwners) {
      pending.previousColonyOwners.set(id, owner);
    }

    const playerAreas: Record<string, number> = {};
    for (const player of gameState.players) {
      if (!player.isSpectator) {
        playerAreas[player.id] = player.totalArea;
        const tracker = pending.playerStatTrackers.get(player.id);
        if (tracker && player.totalArea > tracker.maxArea) {
          tracker.maxArea = player.totalArea;
        }
        if (tracker && !player.isAlive && tracker.eliminatedTurn === null) {
          tracker.eliminatedTurn = currentTurn;
        }
      }
    }

    pending.areaHistory.push({
      turn: currentTurn,
      areas: { ...playerAreas },
    });

    pending.turnSnapshots.push({
      turn: currentTurn,
      gridSnapshot,
      colonies,
      playerAreas,
    });
  }

  recordTurnEvents(roomId: string, events: EventLogEntry[]): void {
    const pending = this.pendingReplays.get(roomId);
    if (!pending) return;

    pending.turnEvents.push(events);

    const currentTurn = pending.turnSnapshots.length > 0
      ? pending.turnSnapshots[pending.turnSnapshots.length - 1].turn
      : 0;

    const killCount = events.filter(e =>
      e.type === 'attack' && e.message.includes('击败')
    ).length + events.filter(e =>
      e.type === 'elimination'
    ).length;

    if (killCount > 0) {
      pending.turnKillCounts.set(currentTurn, killCount);
    }
  }

  recordMarkers(roomId: string, markers: TacticalMarker[]): void {
    const pending = this.pendingReplays.get(roomId);
    if (!pending) return;

    pending.markers.push(JSON.parse(JSON.stringify(markers)));
  }

  recordChatMessage(roomId: string, message: ChatMessage): void {
    const pending = this.pendingReplays.get(roomId);
    if (!pending) return;

    pending.chatMessages.push(JSON.parse(JSON.stringify(message)));
  }

  recordAllianceFormed(roomId: string, turn: number, playerId1: string, playerId2: string): void {
    const pending = this.pendingReplays.get(roomId);
    if (!pending) return;

    pending.allianceEvents.push({
      turn,
      type: 'formed',
      playerId1,
      playerId2,
    });

    const t1 = pending.playerStatTrackers.get(playerId1);
    const t2 = pending.playerStatTrackers.get(playerId2);
    if (t1) t1.allianceCount++;
    if (t2) t2.allianceCount++;
  }

  recordAllianceBroken(roomId: string, turn: number, playerId1: string, playerId2: string, betrayerId: string): void {
    const pending = this.pendingReplays.get(roomId);
    if (!pending) return;

    pending.allianceEvents.push({
      turn,
      type: 'broken',
      playerId1,
      playerId2,
      betrayerId,
    });

    const t = pending.playerStatTrackers.get(betrayerId);
    if (t) t.betrayalCount++;
  }

  finishRecording(roomId: string, finalGameState: GameState): ReplayData | null {
    const pending = this.pendingReplays.get(roomId);
    if (!pending) return null;

    const totalTurns = finalGameState.turn;

    const playerStats: PlayerStats[] = [];
    for (const [playerId, tracker] of pending.playerStatTrackers) {
      const player = finalGameState.players.find(p => p.id === playerId);
      if (!player) continue;

      const rankIndex = finalGameState.rankings.findIndex(r => r.playerId === playerId);
      const ranking = finalGameState.rankings[rankIndex];

      playerStats.push({
        playerId,
        playerName: player.name,
        playerColor: player.color,
        microbeType: player.microbeType,
        totalSpreadCount: tracker.spreadCount,
        totalAttackCount: tracker.attackCount,
        totalEvolveCount: tracker.evolveCount,
        kills: tracker.kills,
        deaths: tracker.deaths,
        maxAreaPeak: tracker.maxArea,
        survivalTurns: tracker.eliminatedTurn !== null ? tracker.eliminatedTurn : totalTurns,
        allianceCount: tracker.allianceCount,
        betrayalCount: tracker.betrayalCount,
        finalRank: rankIndex + 1,
        finalArea: ranking?.area || 0,
        finalWeightedArea: ranking?.weightedArea || 0,
      });
    }

    let mostViolentTurn = { turn: 0, killCount: 0 };
    for (const [turn, count] of pending.turnKillCounts) {
      if (count > mostViolentTurn.killCount) {
        mostViolentTurn = { turn, killCount: count };
      }
    }

    let mvp: GameStats['mvp'] = null;
    let highestScore = -Infinity;
    for (const ps of playerStats) {
      const score = ps.kills * 3 + ps.maxAreaPeak * 0.5 + ps.survivalTurns * 1 - ps.deaths * 2;
      if (score > highestScore) {
        highestScore = score;
        mvp = {
          playerId: ps.playerId,
          playerName: ps.playerName,
          score,
        };
      }
    }

    const stats: GameStats = {
      totalTurns,
      mostViolentTurn,
      mvp,
      playerStats,
      areaHistory: pending.areaHistory,
    };

    const winner = finalGameState.players.find(p => p.id === finalGameState.winnerId);

    const replayData: ReplayData = {
      replayId: pending.replayId,
      roomId: pending.roomId,
      roomName: pending.roomName,
      gameId: finalGameState.id,
      startTime: pending.startTime,
      endTime: Date.now(),
      maxTurns: finalGameState.maxTurns,
      gridSize: finalGameState.gridSize,
      players: JSON.parse(JSON.stringify(finalGameState.players)),
      initialState: {
        grid: JSON.parse(JSON.stringify(pending.initialGameState.grid)),
        colonies: JSON.parse(JSON.stringify(pending.initialGameState.colonies)),
        turn: pending.initialGameState.turn,
      },
      turnSnapshots: pending.turnSnapshots,
      turnActions: pending.turnActions,
      turnEvents: pending.turnEvents,
      allianceEvents: pending.allianceEvents,
      chatMessages: pending.chatMessages,
      markers: pending.markers,
      finalRankings: JSON.parse(JSON.stringify(finalGameState.rankings)),
      winnerId: finalGameState.winnerId,
      stats,
    };

    this.replays.set(pending.replayId, replayData);

    const listItem: ReplayListItem = {
      replayId: pending.replayId,
      roomId: pending.roomId,
      roomName: pending.roomName,
      startTime: pending.startTime,
      endTime: replayData.endTime,
      totalTurns,
      playerCount: finalGameState.players.filter(p => !p.isSpectator).length,
      winnerName: winner?.name || null,
      winnerColor: winner?.color || null,
    };

    this.replayList.unshift(listItem);

    if (this.replayList.length > MAX_REPLAYS) {
      const removed = this.replayList.pop()!;
      this.replays.delete(removed.replayId);
    }

    this.pendingReplays.delete(roomId);

    return replayData;
  }

  getReplay(replayId: string): ReplayData | null {
    return this.replays.get(replayId) || null;
  }

  getReplayList(): ReplayListItem[] {
    return [...this.replayList];
  }

  getReplayByRoomId(roomId: string): ReplayData | null {
    for (const replay of this.replays.values()) {
      if (replay.roomId === roomId) {
        return replay;
      }
    }
    return null;
  }
}
