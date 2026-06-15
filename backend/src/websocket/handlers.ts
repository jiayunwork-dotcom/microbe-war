import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { RoomManager, ConnectedClient } from '../rooms/RoomManager';
import {
  ClientMessage,
  MicrobeType,
  PlayerAction,
  Player,
} from '../game/types';
import { createPlayer } from '../game/engine';

export function setupWebSocketHandlers(
  wss: WebSocketServer,
  roomManager: RoomManager
) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientId = 'client_' + uuidv4().slice(0, 12);

    const client: ConnectedClient = {
      ws,
      playerId: '',
      roomId: null,
      name: 'Anonymous',
    };

    roomManager.addClient(clientId, client);

    ws.on('message', (data: string) => {
      try {
        const msg: ClientMessage = JSON.parse(data.toString());
        handleMessage(clientId, msg);
      } catch (err) {
        console.error('Parse error:', err);
        sendError(clientId, 'Invalid JSON');
      }
    });

    ws.on('close', () => {
      roomManager.removeClient(clientId);
    });

    ws.on('error', (err) => {
      console.error('WS error for client', clientId, err);
      roomManager.removeClient(clientId);
    });

    function sendError(cid: string, message: string) {
      roomManager.sendToClient(cid, {
        type: 'error',
        payload: { message },
      });
    }

    function handleMessage(cid: string, msg: ClientMessage) {
      switch (msg.type) {
        case 'ping': {
          roomManager.sendToClient(cid, { type: 'pong', payload: Date.now() });
          break;
        }

        case 'create_room': {
          const {
            playerName,
            microbeType,
            roomName,
          }: {
            playerName: string;
            microbeType: MicrobeType;
            roomName: string;
          } = msg.payload || {};

          if (!playerName || !microbeType) {
            return sendError(cid, '缺少必要参数');
          }

          const result = roomManager.createRoom(
            cid,
            roomName || `房间`,
            playerName,
            microbeType
          );

          if (!result) {
            return sendError(cid, '创建房间失败');
          }

          const { roomId, playerId } = result;

          const initialPlayers: Player[] = [];
          initialPlayers.push(
            createPlayer(playerId, playerName, microbeType, true, false)
          );

          roomManager.initializeGameForRoom(roomId, initialPlayers);

          roomManager.sendToClient(cid, {
            type: 'room_created',
            payload: {
              roomId,
              playerId,
              roomInfo: roomManager.getRoomInfo(roomId),
              gameState: roomManager.getGameState(roomId),
            },
          });
          break;
        }

        case 'join_room': {
          const {
            roomId,
            playerName,
            microbeType,
            asSpectator,
          }: {
            roomId: string;
            playerName: string;
            microbeType: MicrobeType;
            asSpectator?: boolean;
          } = msg.payload || {};

          if (!roomId || !playerName || !microbeType) {
            return sendError(cid, '缺少必要参数');
          }

          if (!roomManager.roomExists(roomId)) {
            return sendError(cid, '房间不存在');
          }

          const currentClient = roomManager.getClient(cid);
          const currentState = roomManager.getGameState(roomId);
          const nonSpectatorCount = currentState
            ? currentState.players.filter((p) => !p.isSpectator).length
            : 0;

          let shouldSpectator = !!asSpectator;
          const isPlaying = currentState?.status === 'playing';
          if (isPlaying) shouldSpectator = true;

          const joinResult = roomManager.joinRoom(
            cid,
            roomId,
            playerName,
            microbeType,
            shouldSpectator
          );

          if (!joinResult) {
            return sendError(cid, '加入房间失败（可能已满）');
          }

          const { playerId, players } = joinResult;

          roomManager.sendToClient(cid, {
            type: 'room_joined',
            payload: {
              roomId,
              playerId,
              asSpectator: shouldSpectator,
              roomInfo: roomManager.getRoomInfo(roomId),
              gameState: roomManager.getGameState(roomId),
            },
          });

          const newPlayer = roomManager
            .getGameState(roomId)
            ?.players.find((p) => p.id === playerId);
          roomManager.broadcastToRoom(roomId, {
            type: 'player_joined',
            payload: {
              player: newPlayer,
            },
          });
          break;
        }

        case 'leave_room': {
          const { roomId }: { roomId: string } = msg.payload || {};
          const c = roomManager.getClient(cid);
          const actualRoomId = roomId || c?.roomId;
          if (actualRoomId) {
            roomManager.leaveRoom(cid, actualRoomId);
            roomManager.sendToClient(cid, {
              type: 'room_left',
              payload: {},
            });
          }
          break;
        }

        case 'start_game': {
          const { roomId }: { roomId: string } = msg.payload || {};
          if (!roomId) {
            return sendError(cid, '缺少房间ID');
          }
          const state = roomManager.startGame(cid, roomId);
          if (!state) {
            return sendError(cid, '开始游戏失败（需要房主权限，至少2名玩家）');
          }
          break;
        }

        case 'submit_action': {
          const {
            roomId,
            action,
          }: { roomId: string; action: PlayerAction } = msg.payload || {};
          if (!roomId || !action) {
            return sendError(cid, '缺少参数');
          }
          const ok = roomManager.submitAction(cid, roomId, action);
          roomManager.sendToClient(cid, {
            type: 'action_result',
            payload: { success: ok },
          });
          break;
        }

        case 'submit_turn': {
          const { roomId }: { roomId: string } = msg.payload || {};
          if (!roomId) {
            return sendError(cid, '缺少房间ID');
          }
          const ok = roomManager.submitTurn(cid, roomId);
          if (!ok) {
            return sendError(cid, '提交回合失败');
          }
          break;
        }

        case 'request_rooms': {
          roomManager.sendToClient(cid, {
            type: 'room_list',
            payload: { rooms: roomManager.getRoomInfoList() },
          });
          break;
        }

        case 'toggle_spectator': {
          const { roomId }: { roomId: string } = msg.payload || {};
          const c = roomManager.getClient(cid);
          const actualRoomId = roomId || c?.roomId;
          if (!actualRoomId) {
            return sendError(cid, '未在房间中');
          }

          const res = roomManager.toggleSpectator(cid, actualRoomId);
          roomManager.sendToClient(cid, {
            type: 'spectator_toggled',
            payload: res,
          });
          break;
        }

        default: {
          sendError(cid, '未知消息类型: ' + msg.type);
        }
      }
    }
  });
}
