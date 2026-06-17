import { WebSocket } from 'ws';
import {
  GameState,
  Player,
  PlayerAction,
  RoomInfo,
  ServerMessage,
  ClientMessage,
  MicrobeType,
  ChatMessage,
  TacticalMarker,
  Alliance,
  MarkerType,
  ReplayData,
  KillEvent,
  CustomMapData,
} from '../game/types';
import {
  createGameState,
  createPlayer,
  processTurn,
} from '../game/engine';
import { v4 as uuidv4 } from 'uuid';
import { ReplayManager } from './ReplayManager';
import { MapManager } from './MapManager';

export interface ConnectedClient {
  ws: WebSocket;
  playerId: string;
  roomId: string | null;
  name: string;
}

interface Room {
  id: string;
  name: string;
  hostId: string;
  maxPlayers: number;
  gameState: GameState | null;
  clients: Map<string, ConnectedClient>;
  pendingActions: Map<string, PlayerAction[]>;
  turnTimeout: NodeJS.Timeout | null;
  created: Date;
  chatMessages: ChatMessage[];
  markers: TacticalMarker[];
  alliances: Alliance[];
  customMapId: string | null;
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private clients: Map<string, ConnectedClient> = new Map();
  private replayManager: ReplayManager = new ReplayManager();
  public mapManager: MapManager = new MapManager();

  addClient(clientId: string, client: ConnectedClient) {
    this.clients.set(clientId, client);
  }

  removeClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client && client.roomId) {
      this.leaveRoom(clientId, client.roomId);
    }
    this.clients.delete(clientId);
  }

  getClient(clientId: string): ConnectedClient | undefined {
    return this.clients.get(clientId);
  }

  createRoom(
    clientId: string,
    roomName: string,
    playerName: string,
    microbeType: MicrobeType,
    customMapId: string | null = null
  ): { roomId: string; playerId: string } | null {
    const client = this.clients.get(clientId);
    if (!client) return null;

    if (client.roomId) {
      this.leaveRoom(clientId, client.roomId);
    }

    const roomId = 'room_' + uuidv4().slice(0, 6).toUpperCase();
    const playerId = 'player_' + uuidv4().slice(0, 8);

    const room: Room = {
      id: roomId,
      name: roomName || `房间 ${roomId}`,
      hostId: playerId,
      maxPlayers: 6,
      gameState: null,
      clients: new Map(),
      pendingActions: new Map(),
      turnTimeout: null,
      created: new Date(),
      chatMessages: [],
      markers: [],
      alliances: [],
      customMapId,
    };

    client.roomId = roomId;
    client.playerId = playerId;
    client.name = playerName;

    room.clients.set(playerId, client);
    this.rooms.set(roomId, room);

    return { roomId, playerId };
  }

  joinRoom(
    clientId: string,
    roomId: string,
    playerName: string,
    microbeType: MicrobeType,
    asSpectator: boolean = false
  ): { playerId: string; players: Player[] } | null {
    const client = this.clients.get(clientId);
    if (!client) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    if (client.roomId && client.roomId !== roomId) {
      this.leaveRoom(clientId, client.roomId);
    }

    const nonSpectatorCount = Array.from(room.clients.values()).filter(
      (c) => {
        if (!room.gameState) return !asSpectator;
        const p = room.gameState?.players.find((pl) => pl.id === c.playerId);
        return p && !p.isSpectator;
      }
    ).length;

    if (!asSpectator && nonSpectatorCount >= room.maxPlayers) {
      return null;
    }

    if (room.gameState && room.gameState.status === 'playing' && !asSpectator) {
      asSpectator = true;
    }

    const playerId = 'player_' + uuidv4().slice(0, 8);
    client.roomId = roomId;
    client.playerId = playerId;
    client.name = playerName;

    room.clients.set(playerId, client);

    if (room.gameState) {
      const isHost = room.hostId === playerId;
      const p = createPlayer(
        playerId,
        playerName,
        microbeType,
        isHost,
        asSpectator || room.gameState.status !== 'waiting'
      );
      room.gameState.players.push(p);
    }

    const players: Player[] = room.gameState
      ? room.gameState.players
      : [];

    return { playerId, players };
  }

  leaveRoom(clientId: string, roomId: string) {
    const room = this.rooms.get(roomId);
    const client = this.clients.get(clientId);

    if (!room || !client) return;

    room.clients.delete(client.playerId);

    if (room.gameState) {
      const player = room.gameState.players.find(
        (p) => p.id === client.playerId
      );
      if (player) {
        player.isSpectator = true;
        player.isAlive = false;
      }
    }

    if (room.hostId === client.playerId) {
      const remaining = Array.from(room.clients.values());
      if (remaining.length > 0) {
        const newHost = remaining[0];
        room.hostId = newHost.playerId;
        if (room.gameState) {
          const newHostPlayer = room.gameState.players.find(
            (p) => p.id === newHost.playerId
          );
          if (newHostPlayer) {
            newHostPlayer.isHost = true;
          }
        }
      }
    }

    client.roomId = null;

    if (room.clients.size === 0) {
      if (room.turnTimeout) {
        clearTimeout(room.turnTimeout);
      }
      setTimeout(() => {
        this.rooms.delete(roomId);
      }, 60000);
    } else {
      this.broadcastToRoom(roomId, {
        type: 'player_left',
        payload: { playerId: client.playerId },
      });
      this.broadcastRoomState(roomId);
    }
  }

  startGame(clientId: string, roomId: string): GameState | null {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState) return null;

    if (room.hostId !== this.clients.get(clientId)?.playerId) {
      return null;
    }

    const actualPlayers = room.gameState.players.filter((p) => !p.isSpectator);
    if (actualPlayers.length < 2) {
      return null;
    }

    const idx = room.gameState.players.findIndex(
      (p) => p.id === room.hostId
    );
    if (idx >= 0) {
      room.gameState.players[idx].isHost = true;
    }

    const customMap = room.customMapId
      ? this.mapManager.getMap(room.customMapId)
      : null;
    const freshState = createGameState(room.gameState.players, customMap);
    room.gameState = freshState;
    room.gameState.status = 'playing';

    room.pendingActions.clear();
    for (const p of room.gameState.players) {
      room.pendingActions.set(p.id, []);
    }

    this.broadcastToRoom(roomId, {
      type: 'game_started',
      payload: this.serializeGameState(room.gameState),
    });

    this.replayManager.startRecording(roomId, room.name, room.gameState);

    return room.gameState;
  }

  initializeGameForRoom(roomId: string, initialPlayers: Player[]) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.gameState = {
      id: 'game_' + uuidv4().slice(0, 8),
      status: 'waiting',
      turn: 0,
      maxTurns: 40,
      gridSize: 30,
      grid: [],
      players: initialPlayers,
      colonies: [],
      globalEvents: [],
      eventLog: [],
      winnerId: null,
      rankings: [],
    };
  }

  submitAction(
    clientId: string,
    roomId: string,
    action: PlayerAction
  ): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.status !== 'playing') {
      return false;
    }

    const client = this.clients.get(clientId);
    if (!client || client.playerId !== action.playerId) {
      return false;
    }

    const player = room.gameState.players.find(
      (p) => p.id === action.playerId
    );
    if (!player || player.isSpectator) return false;

    let actions = room.pendingActions.get(action.playerId);
    if (!actions) {
      actions = [];
      room.pendingActions.set(action.playerId, actions);
    }

    actions.push(action);
    return true;
  }

  submitTurn(clientId: string, roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState || room.gameState.status !== 'playing') {
      return false;
    }

    const client = this.clients.get(clientId);
    if (!client) return false;

    const player = room.gameState.players.find(
      (p) => p.id === client.playerId
    );
    if (!player || player.isSpectator) return false;

    player.hasSubmitted = true;

    this.broadcastRoomState(roomId);

    const nonSpectatorPlayers = room.gameState.players.filter(
      (p) => !p.isSpectator && p.isAlive
    );
    const allSubmitted = nonSpectatorPlayers.every((p) => p.hasSubmitted);

    if (allSubmitted) {
      this.resolveTurn(roomId);
    }

    return true;
  }

  resolveTurn(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState) return;

    const allActions: PlayerAction[] = [];
    for (const actions of room.pendingActions.values()) {
      allActions.push(...actions);
    }

    this.checkAllianceBetrayals(roomId, allActions);

    const { events, kills } = processTurn(room.gameState, allActions);
    room.gameState.eventLog.push(...events);

    for (const kill of kills) {
      if (kill.attackerPlayerId !== 'phage') {
        this.replayManager.recordKill(roomId, kill.attackerPlayerId, kill.victimPlayerId);
      }
    }

    this.replayManager.recordTurnSnapshot(roomId, room.gameState, allActions);
    this.replayManager.recordTurnEvents(roomId, events);
    this.replayManager.recordMarkers(roomId, room.markers);

    room.pendingActions.clear();
    for (const p of room.gameState.players) {
      p.hasSubmitted = false;
      room.pendingActions.set(p.id, []);
    }

    this.expireMarkers(roomId);

    const isFinished = room.gameState.status === 'finished';

    this.broadcastToRoom(roomId, {
      type: 'turn_result',
      payload: {
        gameState: this.serializeGameState(room.gameState),
        events,
        markers: room.markers,
        kills,
      },
    });

    if (isFinished) {
      const replayData = this.replayManager.finishRecording(roomId, room.gameState);
      this.broadcastToRoom(roomId, {
        type: 'game_ended_with_stats',
        payload: {
          gameState: this.serializeGameState(room.gameState),
          replayData,
        },
      });
      this.broadcastToRoom(roomId, {
        type: 'game_ended',
        payload: {
          gameState: this.serializeGameState(room.gameState),
        },
      });
    }
  }

  private checkAllianceBetrayals(roomId: string, actions: PlayerAction[]) {
    const room = this.rooms.get(roomId);
    if (!room || !room.alliances.length) return;

    const attackActions = actions.filter(
      (a) => a.actionType === 'attack' && a.colonyId && a.targetPosition
    );

    for (const action of attackActions) {
      const room2 = this.rooms.get(roomId);
      if (!room2 || !room2.gameState) break;

      const attackerColony = room2.gameState.colonies.find(
        (c) => c.id === action.colonyId
      );
      if (!attackerColony) continue;

      const targetPos = action.targetPosition!;
      const targetCell = room2.gameState.grid[targetPos.y]?.[targetPos.x];
      if (!targetCell?.colony) continue;

      const defenderPlayerId = targetCell.colony.playerId;
      const attackerPlayerId = action.playerId;

      if (attackerPlayerId === defenderPlayerId) continue;

      const alliance = room2.alliances.find(
        (a) =>
          (a.playerId1 === attackerPlayerId && a.playerId2 === defenderPlayerId) ||
          (a.playerId1 === defenderPlayerId && a.playerId2 === attackerPlayerId)
      );

      if (alliance) {
        this.breakAlliance(
          roomId,
          alliance.playerId1,
          alliance.playerId2,
          attackerPlayerId
        );
      }
    }
  }

  toggleSpectator(
    clientId: string,
    roomId: string
  ): { success: boolean; isSpectator: boolean } {
    const room = this.rooms.get(roomId);
    const client = this.clients.get(clientId);
    if (!room || !room.gameState || !client) {
      return { success: false, isSpectator: false };
    }

    const player = room.gameState.players.find(
      (p) => p.id === client.playerId
    );
    if (!player) return { success: false, isSpectator: false };

    if (!player.isSpectator && room.gameState.status === 'playing') {
      player.isSpectator = true;
      player.isAlive = false;
    } else if (player.isSpectator && room.gameState.status === 'waiting') {
      player.isSpectator = false;
      player.isAlive = true;
    }

    this.broadcastRoomState(roomId);

    return { success: true, isSpectator: player.isSpectator };
  }

  getRoomInfoList(): RoomInfo[] {
    const infos: RoomInfo[] = [];
    for (const room of this.rooms.values()) {
      let hostName = 'Unknown';
      if (room.gameState) {
        const host = room.gameState.players.find((p) => p.id === room.hostId);
        if (host) hostName = host.name;
      }
      const customMap = room.customMapId
        ? this.mapManager.getMap(room.customMapId)
        : null;
      infos.push({
        id: room.id,
        name: room.name,
        status: room.gameState?.status || 'waiting',
        playerCount: room.clients.size,
        maxPlayers: room.maxPlayers,
        hostName,
        turn: room.gameState?.turn,
        customMapId: room.customMapId,
        customMapName: customMap?.name,
      });
    }
    return infos;
  }

  getRoomInfo(roomId: string): RoomInfo | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    let hostName = 'Unknown';
    if (room.gameState) {
      const host = room.gameState.players.find((p) => p.id === room.hostId);
      if (host) hostName = host.name;
    }
    const customMap = room.customMapId
      ? this.mapManager.getMap(room.customMapId)
      : null;
    return {
      id: room.id,
      name: room.name,
      status: room.gameState?.status || 'waiting',
      playerCount: room.clients.size,
      maxPlayers: room.maxPlayers,
      hostName,
      turn: room.gameState?.turn,
      customMapId: room.customMapId,
      customMapName: customMap?.name,
    };
  }

  setRoomMap(
    clientId: string,
    roomId: string,
    customMapId: string | null
  ): boolean {
    const room = this.rooms.get(roomId);
    const client = this.clients.get(clientId);
    if (!room || !client) return false;
    if (room.hostId !== client.playerId) return false;
    if (customMapId && !this.mapManager.getMap(customMapId)) return false;
    room.customMapId = customMapId;
    return true;
  }

  getGameState(roomId: string): GameState | null {
    return this.rooms.get(roomId)?.gameState || null;
  }

  broadcastToRoom(roomId: string, message: ServerMessage) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const data = JSON.stringify(message);
    for (const client of room.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  broadcastRoomState(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState) return;

    this.broadcastToRoom(roomId, {
      type: 'game_state',
      payload: this.serializeGameState(room.gameState),
    });
  }

  sendToClient(clientId: string, message: ServerMessage) {
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  private serializeGameState(state: GameState): any {
    return state;
  }

  sendChatMessage(
    clientId: string,
    roomId: string,
    content: string
  ): ChatMessage | null {
    const room = this.rooms.get(roomId);
    const client = this.clients.get(clientId);
    if (!room || !client) return null;

    const player = room.gameState?.players.find((p) => p.id === client.playerId);
    if (!player) return null;

    const msg: ChatMessage = {
      id: 'msg_' + uuidv4().slice(0, 8),
      playerId: client.playerId,
      playerName: player.name,
      playerColor: player.color,
      content,
      timestamp: Date.now(),
      isSystem: false,
    };

    room.chatMessages.push(msg);
    if (room.chatMessages.length > 50) {
      room.chatMessages = room.chatMessages.slice(-50);
    }

    this.replayManager.recordChatMessage(roomId, msg);

    this.broadcastToRoom(roomId, {
      type: 'chat_message',
      payload: msg,
    });

    return msg;
  }

  sendSystemChat(roomId: string, content: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const msg: ChatMessage = {
      id: 'msg_' + uuidv4().slice(0, 8),
      playerId: 'system',
      playerName: '系统',
      playerColor: '#ffd93d',
      content,
      timestamp: Date.now(),
      isSystem: true,
    };

    room.chatMessages.push(msg);
    if (room.chatMessages.length > 50) {
      room.chatMessages = room.chatMessages.slice(-50);
    }

    this.replayManager.recordChatMessage(roomId, msg);

    this.broadcastToRoom(roomId, {
      type: 'chat_message',
      payload: msg,
    });
  }

  getChatHistory(roomId: string): ChatMessage[] {
    return this.rooms.get(roomId)?.chatMessages || [];
  }

  placeMarker(
    clientId: string,
    roomId: string,
    markerType: MarkerType,
    position: { x: number; y: number }
  ): TacticalMarker | null {
    const room = this.rooms.get(roomId);
    const client = this.clients.get(clientId);
    if (!room || !client) return null;
    if (!room.gameState || room.gameState.status !== 'playing') return null;

    const player = room.gameState.players.find((p) => p.id === client.playerId);
    if (!player || player.isSpectator) return null;

    const playerMarkers = room.markers.filter((m) => m.playerId === client.playerId);
    if (playerMarkers.length >= 3) {
      const oldest = playerMarkers[0];
      room.markers = room.markers.filter((m) => m.id !== oldest.id);
      this.broadcastToRoom(roomId, {
        type: 'marker_removed',
        payload: { markerId: oldest.id },
      });
    }

    const marker: TacticalMarker = {
      id: 'marker_' + uuidv4().slice(0, 8),
      playerId: client.playerId,
      type: markerType,
      position,
      placedTurn: room.gameState.turn,
      color: player.color,
    };

    room.markers.push(marker);

    this.broadcastToRoom(roomId, {
      type: 'marker_placed',
      payload: marker,
    });

    return marker;
  }

  expireMarkers(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameState) return;

    const currentTurn = room.gameState.turn;
    const expired = room.markers.filter((m) => currentTurn - m.placedTurn >= 8);

    for (const marker of expired) {
      this.broadcastToRoom(roomId, {
        type: 'marker_removed',
        payload: { markerId: marker.id },
      });
    }

    room.markers = room.markers.filter((m) => currentTurn - m.placedTurn < 8);
  }

  getMarkers(roomId: string): TacticalMarker[] {
    return this.rooms.get(roomId)?.markers || [];
  }

  requestAlliance(
    clientId: string,
    roomId: string,
    targetPlayerId: string
  ): boolean {
    const room = this.rooms.get(roomId);
    const client = this.clients.get(clientId);
    if (!room || !client) return false;

    const requester = room.gameState?.players.find((p) => p.id === client.playerId);
    const target = room.gameState?.players.find((p) => p.id === targetPlayerId);
    if (!requester || !target) return false;

    const existing = this.getAlliancesForPlayer(roomId, client.playerId);
    if (existing.length >= 2) return false;

    const alreadyAllied = room.alliances.some(
      (a) =>
        (a.playerId1 === client.playerId && a.playerId2 === targetPlayerId) ||
        (a.playerId1 === targetPlayerId && a.playerId2 === client.playerId)
    );
    if (alreadyAllied) return false;

    const targetClient = Array.from(room.clients.values()).find(
      (c) => c.playerId === targetPlayerId
    );
    if (!targetClient) return false;

    this.sendToClient(
      this.getClientIdByPlayerId(roomId, targetPlayerId),
      {
        type: 'alliance_request_received',
        payload: {
          fromPlayerId: client.playerId,
          fromPlayerName: requester.name,
          fromPlayerColor: requester.color,
        },
      }
    );

    return true;
  }

  respondAlliance(
    clientId: string,
    roomId: string,
    fromPlayerId: string,
    accept: boolean
  ): boolean {
    const room = this.rooms.get(roomId);
    const client = this.clients.get(clientId);
    if (!room || !client) return false;

    if (!accept) return true;

    const responder = room.gameState?.players.find((p) => p.id === client.playerId);
    if (!responder) return false;

    const existingAlliances = this.getAlliancesForPlayer(roomId, client.playerId);
    if (existingAlliances.length >= 2) return false;

    const requesterAlliances = this.getAlliancesForPlayer(roomId, fromPlayerId);
    if (requesterAlliances.length >= 2) return false;

    const alreadyAllied = room.alliances.some(
      (a) =>
        (a.playerId1 === fromPlayerId && a.playerId2 === client.playerId) ||
        (a.playerId1 === client.playerId && a.playerId2 === fromPlayerId)
    );
    if (alreadyAllied) return false;

    const alliance: Alliance = {
      playerId1: fromPlayerId,
      playerId2: client.playerId,
    };

    room.alliances.push(alliance);

    const fromPlayer = room.gameState?.players.find((p) => p.id === fromPlayerId);
    this.broadcastToRoom(roomId, {
      type: 'alliance_formed',
      payload: {
        alliance,
        player1Name: fromPlayer?.name,
        player2Name: responder.name,
      },
    });

    if (room.gameState) {
      this.replayManager.recordAllianceFormed(
        roomId,
        room.gameState.turn,
        fromPlayerId,
        client.playerId
      );
    }

    this.sendSystemChat(roomId, `${fromPlayer?.name} 与 ${responder.name} 结成了联盟！`);

    this.broadcastAlliances(roomId);

    return true;
  }

  breakAlliance(roomId: string, playerId1: string, playerId2: string, betrayerId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.alliances = room.alliances.filter(
      (a) =>
        !(
          (a.playerId1 === playerId1 && a.playerId2 === playerId2) ||
          (a.playerId1 === playerId2 && a.playerId2 === playerId1)
        )
    );

    if (room.gameState) {
      this.replayManager.recordAllianceBroken(
        roomId,
        room.gameState.turn,
        playerId1,
        playerId2,
        betrayerId
      );
    }

    const betrayer = room.gameState?.players.find((p) => p.id === betrayerId);
    const victim = room.gameState?.players.find(
      (p) => p.id === (betrayerId === playerId1 ? playerId2 : playerId1)
    );

    this.broadcastToRoom(roomId, {
      type: 'alliance_broken',
      payload: {
        playerId1,
        playerId2,
        betrayerId,
        betrayerName: betrayer?.name,
        victimName: victim?.name,
      },
    });

    this.sendSystemChat(
      roomId,
      `${betrayer?.name} 背叛了与 ${victim?.name} 的联盟！`
    );

    this.broadcastAlliances(roomId);
  }

  getAlliancesForPlayer(roomId: string, playerId: string): Alliance[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return room.alliances.filter(
      (a) => a.playerId1 === playerId || a.playerId2 === playerId
    );
  }

  getAlliances(roomId: string): Alliance[] {
    return this.rooms.get(roomId)?.alliances || [];
  }

  broadcastAlliances(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    this.broadcastToRoom(roomId, {
      type: 'alliances_update',
      payload: { alliances: room.alliances },
    });
  }

  private getClientIdByPlayerId(roomId: string, playerId: string): string {
    const room = this.rooms.get(roomId);
    if (!room) return '';
    for (const [clientId, client] of room.clients) {
      if (client.playerId === playerId) return clientId;
    }
    return '';
  }

  roomExists(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  getRoomHost(roomId: string): string | null {
    return this.rooms.get(roomId)?.hostId || null;
  }

  getReplay(replayId: string): ReplayData | null {
    return this.replayManager.getReplay(replayId);
  }

  getReplayByRoomId(roomId: string): ReplayData | null {
    return this.replayManager.getReplayByRoomId(roomId);
  }

  getReplayList() {
    return this.replayManager.getReplayList();
  }
}
