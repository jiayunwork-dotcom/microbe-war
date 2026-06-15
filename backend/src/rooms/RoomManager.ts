import { WebSocket } from 'ws';
import {
  GameState,
  Player,
  PlayerAction,
  RoomInfo,
  ServerMessage,
  ClientMessage,
  MicrobeType,
} from '../game/types';
import {
  createGameState,
  createPlayer,
  processTurn,
} from '../game/engine';
import { v4 as uuidv4 } from 'uuid';

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
}

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private clients: Map<string, ConnectedClient> = new Map();

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
    microbeType: MicrobeType
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

    const freshState = createGameState(room.gameState.players);
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

    const { events } = processTurn(room.gameState, allActions);
    room.gameState.eventLog.push(...events);

    room.pendingActions.clear();
    for (const p of room.gameState.players) {
      p.hasSubmitted = false;
      room.pendingActions.set(p.id, []);
    }

    const isFinished = room.gameState.status === 'finished';

    this.broadcastToRoom(roomId, {
      type: 'turn_result',
      payload: {
        gameState: this.serializeGameState(room.gameState),
        events,
      },
    });

    if (isFinished) {
      this.broadcastToRoom(roomId, {
        type: 'game_ended',
        payload: {
          gameState: this.serializeGameState(room.gameState),
        },
      });
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
      infos.push({
        id: room.id,
        name: room.name,
        status: room.gameState?.status || 'waiting',
        playerCount: room.clients.size,
        maxPlayers: room.maxPlayers,
        hostName,
        turn: room.gameState?.turn,
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
    return {
      id: room.id,
      name: room.name,
      status: room.gameState?.status || 'waiting',
      playerCount: room.clients.size,
      maxPlayers: room.maxPlayers,
      hostName,
      turn: room.gameState?.turn,
    };
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

  roomExists(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  getRoomHost(roomId: string): string | null {
    return this.rooms.get(roomId)?.hostId || null;
  }
}
