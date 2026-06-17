import {
  GameState,
  Player,
  MicrobeType,
  RoomInfo,
  Position,
  ActionType,
  EventLogEntry,
  Colony,
  PlayerAction,
  ChatMessage,
  TacticalMarker,
  MarkerType,
  Alliance,
  ReplayData,
  ReplayListItem,
  PlayerStats,
  GameStats,
  TurnAction,
  AllianceEvent,
  Highlight,
  TerrainType,
  SymmetryMode,
  BrushSize,
  EditMode,
  MapListItem,
  MapValidationResult,
  CustomMapData,
  MapPresetType,
} from './types.js';
import { GameWebSocket } from './network.js';
import { DishRenderer, RenderAnimation } from './renderer.js';
import { MapEditor, fetchMapList, thumbnailToDataUrl, renderThumbnailToCanvas, getOrCreateClientId } from './mapEditor.js';

const MICROBE_NAMES: Record<MicrobeType, string> = {
  bacteria: '🦠 细菌',
  fungi: '🍄 真菌',
  protozoa: '🦠 原生动物',
  phage: '☠️ 噬菌体',
};

class GameController {
  private network: GameWebSocket;
  private renderer: DishRenderer | null = null;
  private replayRenderer: DishRenderer | null = null;
  private replayRendererLeft: DishRenderer | null = null;
  private replayRendererRight: DishRenderer | null = null;

  private roomId: string = '';
  private myPlayerId: string = '';
  private gameState: GameState | null = null;
  private currentAction: ActionType = 'spread';
  private selectedColonyId: string | null = null;

  private submitted: boolean = false;
  private markerMode: MarkerType | null = null;
  private alliances: Alliance[] = [];
  private pendingAllianceFrom: string | null = null;

  private currentReplay: ReplayData | null = null;
  private replayTurn: number = 0;
  private isPlaying: boolean = false;
  private playbackSpeed: number = 1;
  private playbackTimer: number | null = null;
  private latestStats: GameStats | null = null;

  private compareMode: boolean = false;
  private compareReplayLeft: ReplayData | null = null;
  private compareReplayRight: ReplayData | null = null;
  private compareProgressRatio: number = 0;
  private compareIsPlaying: boolean = false;
  private comparePlaybackSpeed: number = 1;
  private comparePlaybackTimer: number | null = null;
  private pendingCompareReplayId: string = '';

  private mapEditor: MapEditor | null = null;
  private cachedMaps: MapListItem[] = [];

  constructor() {
    this.network = new GameWebSocket('ws://localhost:3001/ws');
  }

  async init() {
    try {
      await this.network.connect();
    } catch (err) {
      this.showLobbyMessage('连接服务器失败，请刷新重试', true);
      return;
    }

    this.setupNetworkHandlers();
    this.setupUIHandlers();
    this.requestRoomList();
    this.refreshLobbyMapList();
    this.checkUrlReplayParam();
  }

  private checkUrlReplayParam() {
    const params = new URLSearchParams(window.location.search);
    const replayId = params.get('replay');
    if (replayId) {
      setTimeout(() => {
        this.requestReplayById(replayId);
      }, 500);
    }
    const compareReplayId = params.get('compare');
    if (compareReplayId) {
      this.pendingCompareReplayId = compareReplayId;
    }
  }

  private setupNetworkHandlers() {
    this.network.on('pong', () => {});

    this.network.on('room_created', (payload) => {
      this.roomId = payload.roomId;
      this.myPlayerId = payload.playerId;
      this.gameState = payload.gameState;
      this.showScreen('waiting-screen');
      this.updateWaitingRoom();
    });

    this.network.on('room_joined', (payload) => {
      this.roomId = payload.roomId;
      this.myPlayerId = payload.playerId;
      this.gameState = payload.gameState;
      this.showScreen('waiting-screen');
      this.updateWaitingRoom();
    });

    this.network.on('room_list', (payload) => {
      this.renderRoomList(payload.rooms || []);
    });

    this.network.on('player_joined', () => {
      this.requestRoomState();
    });

    this.network.on('player_left', () => {
      this.requestRoomState();
    });

    this.network.on('game_started', (payload) => {
      this.gameState = payload;
      this.startGameScreen();
    });

    this.network.on('game_state', (payload) => {
      this.gameState = payload;
      const gs = this.gameState!;
      if (gs.status === 'playing') {
        this.updateGameScreen();
      } else if (gs.status === 'waiting') {
        this.updateWaitingRoom();
      } else if (gs.status === 'finished') {
        this.showResultScreen();
      }
    });

    this.network.on('turn_result', (payload) => {
      this.gameState = payload.gameState;
      this.submitted = false;
      if (payload.markers && this.renderer) {
        this.renderer.setMarkers(payload.markers);
      }
      this.updateGameScreen();
      this.playTurnAnimations(payload.events || []);
      if (this.gameState!.status === 'finished') {
        setTimeout(() => this.showResultScreen(), 800);
      }
    });

    this.network.on('game_ended', (payload) => {
      this.gameState = payload.gameState;
      setTimeout(() => this.showResultScreen(), 500);
    });

    this.network.on('action_result', (payload) => {
      if (!payload.success) {
        this.showLobbyMessage('操作失败', true);
      }
    });

    this.network.on('spectator_toggled', (payload) => {
      console.log('Spectator toggled:', payload);
    });

    this.network.on('room_left', () => {
      this.roomId = '';
      this.myPlayerId = '';
      this.gameState = null;
      this.alliances = [];
      this.showScreen('lobby-screen');
      this.requestRoomList();
    });

    this.network.on('error', (payload) => {
      this.showLobbyMessage(payload.message || '发生错误', true);
    });

    this.network.on('chat_message', (payload: ChatMessage) => {
      this.appendChatMessage(payload);
    });

    this.network.on('marker_placed', (payload: TacticalMarker) => {
      if (this.renderer) {
        this.renderer.addMarker(payload);
      }
    });

    this.network.on('marker_removed', (payload: { markerId: string }) => {
      if (this.renderer) {
        this.renderer.removeMarker(payload.markerId);
      }
    });

    this.network.on('alliance_request_received', (payload) => {
      this.pendingAllianceFrom = payload.fromPlayerId;
      const modal = document.getElementById('alliance-request-modal');
      const text = document.getElementById('alliance-request-text');
      if (modal && text) {
        text.innerHTML = `<span style="color:${payload.fromPlayerColor}">${this.escapeHtml(payload.fromPlayerName)}</span> 请求与你结盟`;
        modal.style.display = 'flex';
      }
    });

    this.network.on('alliance_formed', (_payload) => {
    });

    this.network.on('alliance_broken', (_payload) => {
    });

    this.network.on('alliances_update', (payload) => {
      this.alliances = payload.alliances || [];
      this.updatePlayerStats();
    });

    this.network.on('game_ended_with_stats', (payload) => {
      if (payload.replayData) {
        this.currentReplay = payload.replayData;
        this.latestStats = payload.replayData.stats;
      }
    });

    this.network.on('replay_data', (payload) => {
      this.currentReplay = payload;
      this.latestStats = payload.stats;
      this.startReplayPlayer();
    });

    this.network.on('replay_list', (payload) => {
      console.log('Replay list:', payload.replays);
    });

    this.network.on('room_updated', (payload) => {
      if (payload?.roomInfo && this.gameState) {
        this.updateWaitingRoomWithMap(payload.roomInfo);
      }
    });

    this.network.on('map_liked', (payload) => {
      console.log('Map liked:', payload);
    });
  }

  private setupUIHandlers() {
    document.getElementById('btn-create-room')?.addEventListener('click', () => {
      this.handleCreateRoom();
    });

    document.getElementById('btn-join-room')?.addEventListener('click', () => {
      this.handleJoinRoom();
    });

    document.getElementById('btn-refresh-rooms')?.addEventListener('click', () => {
      this.requestRoomList();
    });

    document.getElementById('btn-start-game')?.addEventListener('click', () => {
      this.handleStartGame();
    });

    document.getElementById('btn-leave-waiting')?.addEventListener('click', () => {
      this.handleLeaveRoom();
    });

    document.getElementById('btn-submit-turn')?.addEventListener('click', () => {
      this.handleSubmitTurn();
    });

    document.getElementById('btn-leave-game')?.addEventListener('click', () => {
      this.handleLeaveRoom();
    });

    document.getElementById('btn-spectate-toggle')?.addEventListener('click', () => {
      this.handleToggleSpectator();
    });

    document.getElementById('btn-back-lobby')?.addEventListener('click', () => {
      this.roomId = '';
      this.myPlayerId = '';
      this.gameState = null;
      this.alliances = [];
      this.showScreen('lobby-screen');
      this.requestRoomList();
    });

    document.querySelectorAll('.btn-action').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const action = target.dataset.action as ActionType;
        if (action) {
          this.setCurrentAction(action);
        }
      });
    });

    document.querySelectorAll('.btn-marker').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const markerType = target.dataset.marker as MarkerType;
        if (markerType) {
          this.toggleMarkerMode(markerType);
        }
      });
    });

    const waitingInput = document.getElementById('waiting-chat-input') as HTMLInputElement;
    const waitingSendBtn = document.getElementById('waiting-chat-send');
    if (waitingInput) {
      waitingInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.sendChatFromInput('waiting-chat-input');
        }
      });
    }
    if (waitingSendBtn) {
      waitingSendBtn.addEventListener('click', () => {
        this.sendChatFromInput('waiting-chat-input');
      });
    }

    const gameInput = document.getElementById('game-chat-input') as HTMLInputElement;
    const gameSendBtn = document.getElementById('game-chat-send');
    if (gameInput) {
      gameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.sendChatFromInput('game-chat-input');
        }
      });
    }
    if (gameSendBtn) {
      gameSendBtn.addEventListener('click', () => {
        this.sendChatFromInput('game-chat-input');
      });
    }

    document.querySelectorAll('.btn-quick-phrase').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const phrase = target.dataset.phrase;
        if (phrase) {
          this.sendChatMessage(phrase);
        }
      });
    });

    document.getElementById('btn-alliance-accept')?.addEventListener('click', () => {
      if (this.pendingAllianceFrom) {
        this.network.send({
          type: 'alliance_respond',
          payload: {
            roomId: this.roomId,
            fromPlayerId: this.pendingAllianceFrom,
            accept: true,
          },
        });
        this.pendingAllianceFrom = null;
      }
      const modal = document.getElementById('alliance-request-modal');
      if (modal) modal.style.display = 'none';
    });

    document.getElementById('btn-alliance-reject')?.addEventListener('click', () => {
      if (this.pendingAllianceFrom) {
        this.network.send({
          type: 'alliance_respond',
          payload: {
            roomId: this.roomId,
            fromPlayerId: this.pendingAllianceFrom,
            accept: false,
          },
        });
        this.pendingAllianceFrom = null;
      }
      const modal = document.getElementById('alliance-request-modal');
      if (modal) modal.style.display = 'none';
    });

    document.getElementById('btn-watch-replay')?.addEventListener('click', () => {
      if (this.currentReplay) {
        this.startReplayPlayer();
      }
    });

    document.getElementById('btn-exit-replay')?.addEventListener('click', () => {
      this.stopReplay();
      this.showScreen('result-screen');
    });

    document.getElementById('btn-replay-play')?.addEventListener('click', () => {
      this.toggleReplayPlay();
    });

    document.querySelectorAll('.btn-speed').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const speed = parseInt(target.dataset.speed || '1', 10);
        this.setPlaybackSpeed(speed);
      });
    });

    const replayProgress = document.getElementById('replay-progress') as HTMLInputElement;
    if (replayProgress) {
      replayProgress.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const turn = parseInt(target.value, 10);
        this.seekToTurn(turn);
      });
    }

    document.getElementById('btn-query-replay')?.addEventListener('click', () => {
      const input = document.getElementById('replay-id-query') as HTMLInputElement;
      if (!input) return;
      const replayId = input.value.trim();
      if (!replayId) {
        this.showLobbyMessage('请输入回放ID', true);
        return;
      }
      this.requestReplayById(replayId);
    });

    const replayQueryInput = document.getElementById('replay-id-query') as HTMLInputElement;
    if (replayQueryInput) {
      replayQueryInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          document.getElementById('btn-query-replay')?.click();
        }
      });
    }

    document.getElementById('btn-share-replay')?.addEventListener('click', () => {
      this.shareReplay();
    });

    document.getElementById('btn-export-replay')?.addEventListener('click', () => {
      this.exportReplayData();
    });

    document.getElementById('btn-compare-toggle')?.addEventListener('click', () => {
      this.toggleCompareMode();
    });

    document.getElementById('btn-exit-compare')?.addEventListener('click', () => {
      this.exitCompareMode();
    });

    document.getElementById('btn-load-compare')?.addEventListener('click', () => {
      const input = document.getElementById('compare-replay-id-input') as HTMLInputElement;
      if (!input) return;
      const replayId = input.value.trim();
      if (!replayId) {
        this.showLobbyMessage('请输入回放ID', true);
        return;
      }
      this.loadCompareReplay(replayId);
    });

    const compareInput = document.getElementById('compare-replay-id-input') as HTMLInputElement;
    if (compareInput) {
      compareInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          document.getElementById('btn-load-compare')?.click();
        }
      });
    }

    document.getElementById('btn-replay-play-compare')?.addEventListener('click', () => {
      this.toggleComparePlay();
    });

    document.querySelectorAll('.btn-speed-compare').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const speed = parseInt(target.dataset.speed || '1', 10);
        this.setComparePlaybackSpeed(speed);
      });
    });

    const replayProgressLeft = document.getElementById('replay-progress-left') as HTMLInputElement;
    if (replayProgressLeft) {
      replayProgressLeft.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const turn = parseInt(target.value, 10);
        this.seekCompareTurn(turn, 'left');
      });
    }

    const replayProgressRight = document.getElementById('replay-progress-right') as HTMLInputElement;
    if (replayProgressRight) {
      replayProgressRight.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        const turn = parseInt(target.value, 10);
        this.seekCompareTurn(turn, 'right');
      });
    }

    document.getElementById('btn-open-map-editor')?.addEventListener('click', () => {
      this.openMapEditor();
    });

    document.getElementById('btn-map-editor-back')?.addEventListener('click', () => {
      this.showScreen('lobby-screen');
    });

    document.querySelectorAll('.btn-terrain').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-terrain').forEach((b) =>
          b.classList.remove('active')
        );
        const target = e.currentTarget as HTMLElement;
        target.classList.add('active');
        const terrain = target.dataset.terrain as TerrainType;
        if (terrain && this.mapEditor) {
          this.mapEditor.setTerrain(terrain);
        }
      });
    });

    document.querySelectorAll('.btn-brush-size').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-brush-size').forEach((b) =>
          b.classList.remove('active')
        );
        const target = e.currentTarget as HTMLElement;
        target.classList.add('active');
        const size = parseInt(target.dataset.size || '1', 10) as BrushSize;
        if (this.mapEditor) {
          this.mapEditor.setBrushSize(size);
        }
      });
    });

    document.querySelectorAll('.btn-symmetry').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-symmetry').forEach((b) =>
          b.classList.remove('active')
        );
        const target = e.currentTarget as HTMLElement;
        target.classList.add('active');
        const mode = target.dataset.symmetry as SymmetryMode;
        if (mode && this.mapEditor) {
          this.mapEditor.setSymmetryMode(mode);
        }
      });
    });

    document.querySelectorAll('.btn-edit-mode').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-edit-mode').forEach((b) =>
          b.classList.remove('active')
        );
        const target = e.currentTarget as HTMLElement;
        target.classList.add('active');
        const mode = target.dataset.mode as EditMode;
        if (mode && this.mapEditor) {
          this.mapEditor.setEditMode(mode);
        }
      });
    });

    document.getElementById('btn-undo')?.addEventListener('click', () => {
      if (this.mapEditor) {
        this.mapEditor.undo();
      }
    });

    document.getElementById('btn-redo')?.addEventListener('click', () => {
      if (this.mapEditor) {
        this.mapEditor.redo();
      }
    });

    document.querySelectorAll('.btn-preset').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const preset = target.dataset.preset as MapPresetType;
        if (preset && this.mapEditor) {
          this.mapEditor.loadPreset(preset);
        }
      });
    });

    document.getElementById('btn-clear-map')?.addEventListener('click', () => {
      if (this.mapEditor) {
        if (confirm('确定要清空当前地图吗？')) {
          this.mapEditor.clearMap();
        }
      }
    });

    document.getElementById('btn-validate-map')?.addEventListener('click', () => {
      this.validateCurrentMap();
    });

    document.getElementById('btn-save-map')?.addEventListener('click', () => {
      this.saveCurrentMap();
    });

    document.getElementById('btn-refresh-maps')?.addEventListener('click', () => {
      this.refreshLobbyMapList();
    });

    document.getElementById('btn-refresh-saved-maps')?.addEventListener('click', () => {
      this.refreshSavedMapList();
    });

    document.getElementById('waiting-map-select')?.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      const mapId = target.value || null;
      this.setRoomMap(mapId);
    });
  }

  private sendChatFromInput(inputId: string) {
    const input = document.getElementById(inputId) as HTMLInputElement;
    if (!input) return;
    const text = input.value.trim();
    if (text) {
      this.sendChatMessage(text);
      input.value = '';
    }
  }

  private sendChatMessage(content: string) {
    this.network.send({
      type: 'send_chat',
      payload: {
        roomId: this.roomId,
        content,
      },
    });
  }

  private appendChatMessage(msg: ChatMessage) {
    const containers = ['waiting-chat-messages', 'game-chat-messages'];
    for (const containerId of containers) {
      const container = document.getElementById(containerId);
      if (!container) continue;

      const div = document.createElement('div');
      div.className = 'chat-msg' + (msg.isSystem ? ' system' : '');

      if (msg.isSystem) {
        div.textContent = msg.content;
      } else {
        const time = new Date(msg.timestamp);
        const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
        div.innerHTML = `<span class="chat-msg-name" style="color:${msg.playerColor}">${this.escapeHtml(msg.playerName)}</span>${this.escapeHtml(msg.content)}<span class="chat-msg-time">${timeStr}</span>`;
      }

      container.appendChild(div);
      container.scrollTop = container.scrollHeight;

      while (container.children.length > 50) {
        container.removeChild(container.firstChild!);
      }
    }
  }

  private toggleMarkerMode(markerType: MarkerType) {
    if (this.markerMode === markerType) {
      this.markerMode = null;
    } else {
      this.markerMode = markerType;
    }

    if (this.renderer) {
      this.renderer.setMarkerMode(this.markerMode);
    }

    document.querySelectorAll('.btn-marker').forEach((b) => {
      const el = b as HTMLElement;
      el.classList.toggle('active', el.dataset.marker === this.markerMode);
    });

    if (this.markerMode) {
      document.querySelectorAll('.btn-action').forEach((b) => {
        (b as HTMLElement).classList.remove('active');
      });
    } else {
      this.setCurrentAction(this.currentAction);
    }
  }

  private handleCreateRoom() {
    const nameEl = document.getElementById('player-name-create') as HTMLInputElement;
    const typeEl = document.getElementById('microbe-type-create') as HTMLSelectElement;
    const roomNameEl = document.getElementById('room-name-create') as HTMLInputElement;
    const mapSelectEl = document.getElementById('map-select-create') as HTMLSelectElement;

    const name = nameEl.value.trim();
    const type = typeEl.value as MicrobeType;
    const roomName = roomNameEl.value.trim();
    const customMapId = mapSelectEl?.value || null;

    if (!name) {
      this.showLobbyMessage('请输入玩家名称', true);
      return;
    }

    this.network.send({
      type: 'create_room',
      payload: {
        playerName: name,
        microbeType: type,
        roomName: roomName || `${name}的房间`,
        customMapId: customMapId || undefined,
      },
    });
  }

  private handleJoinRoom() {
    const nameEl = document.getElementById('player-name-join') as HTMLInputElement;
    const typeEl = document.getElementById('microbe-type-join') as HTMLSelectElement;
    const roomIdEl = document.getElementById('room-id-join') as HTMLInputElement;

    const name = nameEl.value.trim();
    const type = typeEl.value as MicrobeType;
    const roomId = roomIdEl.value.trim().toUpperCase();

    if (!name || !roomId) {
      this.showLobbyMessage('请填写玩家名称和房间ID', true);
      return;
    }

    this.network.send({
      type: 'join_room',
      payload: {
        playerName: name,
        microbeType: type,
        roomId,
      },
    });
  }

  private handleStartGame() {
    this.network.send({
      type: 'start_game',
      payload: { roomId: this.roomId },
    });
  }

  private handleLeaveRoom() {
    this.network.send({
      type: 'leave_room',
      payload: { roomId: this.roomId },
    });
  }

  private handleSubmitTurn() {
    if (this.submitted) return;
    this.submitted = true;
    this.network.send({
      type: 'submit_turn',
      payload: { roomId: this.roomId },
    });
    this.updateSubmitStatus();
  }

  private handleToggleSpectator() {
    this.network.send({
      type: 'toggle_spectator',
      payload: { roomId: this.roomId },
    });
  }

  private requestRoomList() {
    this.network.send({ type: 'request_rooms' });
  }

  private requestRoomState() {}

  private showScreen(screenId: string) {
    document.querySelectorAll('.screen').forEach((s) => {
      s.classList.remove('active');
    });
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
  }

  private showLobbyMessage(msg: string, isError: boolean = false) {
    const el = document.getElementById('lobby-message');
    if (!el) return;
    el.textContent = msg;
    el.className = 'lobby-message ' + (isError ? 'error' : 'success');
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = '';
    }, 3000);
  }

  private renderRoomList(rooms: RoomInfo[]) {
    const listEl = document.getElementById('room-list');
    if (!listEl) return;

    if (rooms.length === 0) {
      listEl.innerHTML = '<div class="empty-text">暂无房间，快来创建第一个！</div>';
      return;
    }

    listEl.innerHTML = rooms
      .map(
        (r) => `
      <div class="room-item" data-room-id="${r.id}">
        <div class="room-item-header">
          <span class="room-item-name">${this.escapeHtml(r.name)}</span>
          <span class="room-item-status status-${r.status}">
            ${r.status === 'waiting' ? '等待中' : r.status === 'playing' ? '游戏中' : '已结束'}
          </span>
        </div>
        <div class="room-item-info">
          <span>ID: ${r.id}</span>
          <span>${r.playerCount}/${r.maxPlayers}人</span>
          <span>房主: ${this.escapeHtml(r.hostName)}</span>
          ${r.turn !== undefined ? `<span>回合: ${r.turn}</span>` : ''}
        </div>
        <div class="room-item-actions">
          ${r.status === 'finished' ? `
            <button class="btn btn-small btn-replay-room" data-room-id="${r.id}">查看回放</button>
          ` : `
            <button class="btn btn-small room-item-join" data-room-id="${r.id}">快速加入</button>
          `}
        </div>
      </div>
    `
      )
      .join('');

    listEl.querySelectorAll('.room-item-join').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const roomId = target.dataset.roomId;
        if (roomId) {
          (document.getElementById('room-id-join') as HTMLInputElement).value = roomId;
        }
      });
    });

    listEl.querySelectorAll('.btn-replay-room').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const roomId = target.dataset.roomId;
        if (roomId) {
          this.requestReplayByRoomId(roomId);
        }
      });
    });
  }

  private updateWaitingRoom() {
    if (!this.gameState) return;

    document.getElementById('waiting-room-id')!.textContent = this.roomId;
    document.getElementById('waiting-player-count')!.textContent =
      String(this.gameState.players.filter((p) => !p.isSpectator).length);

    const waitingEl = document.getElementById('waiting-players');
    if (!waitingEl) return;

    waitingEl.innerHTML = this.gameState.players
      .map((p) => {
        const me = p.id === this.myPlayerId ? ' (你)' : '';
        const isAllied = this.isAlliedWith(p.id);
        return `
      <div class="waiting-player">
        <div class="player-color-dot" style="background:${p.color}"></div>
        <div class="player-info">
          <span class="player-name">${this.escapeHtml(p.name)}${me}</span>
          <span class="player-type">${MICROBE_NAMES[p.microbeType]}</span>
          ${p.isHost ? '<span class="player-badge host">房主</span>' : ''}
          ${p.isSpectator ? '<span class="player-badge spec">观战</span>' : ''}
          ${isAllied ? '<span class="alliance-icon">🤝</span>' : ''}
        </div>
        ${!p.isSpectator && p.id !== this.myPlayerId ? `<button class="btn-alliance" data-target-id="${p.id}">${isAllied ? '🤝 已结盟' : '请求结盟'}</button>` : ''}
      </div>
    `;
      })
      .join('');

    waitingEl.querySelectorAll('.btn-alliance').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const targetId = target.dataset.targetId;
        if (targetId && !this.isAlliedWith(targetId)) {
          this.network.send({
            type: 'alliance_request',
            payload: {
              roomId: this.roomId,
              targetPlayerId: targetId,
            },
          });
        }
      });
    });

    const startBtn = document.getElementById('btn-start-game');
    if (startBtn) {
      const me = this.gameState.players.find((p) => p.id === this.myPlayerId);
      if (me?.isHost && this.gameState.players.filter((p) => !p.isSpectator).length >= 2) {
        startBtn.style.display = 'inline-block';
      } else {
        startBtn.style.display = 'none';
      }
    }

    this.updateWaitingRoomMapUI();
  }

  private updateWaitingRoomWithMap(roomInfo: RoomInfo) {
    const mapNameEl = document.getElementById('waiting-map-name');
    const mapInfoEl = document.getElementById('waiting-map-info');
    if (mapInfoEl && mapNameEl) {
      if (roomInfo.customMapId) {
        mapInfoEl.style.display = 'block';
        mapNameEl.textContent = roomInfo.customMapName || '自定义地图';
      } else {
        mapInfoEl.style.display = 'block';
        mapNameEl.textContent = '🎲 随机地图';
      }
    }
    if (this.gameState) {
      this.updateWaitingRoom();
    }
  }

  private async updateWaitingRoomMapUI() {
    const me = this.gameState?.players.find((p) => p.id === this.myPlayerId);
    const mapSettingsEl = document.getElementById('waiting-map-settings');
    const mapInfoEl = document.getElementById('waiting-map-info');
    const mapNameEl = document.getElementById('waiting-map-name');
    const mapSelectEl = document.getElementById(
      'waiting-map-select'
    ) as HTMLSelectElement;

    const roomInfo: RoomInfo | null = (window as any).__tempRoomInfo || null;
    const customMapName =
      roomInfo?.customMapName ||
      (this.gameState as any)?.customMapName ||
      null;
    const customMapId =
      roomInfo?.customMapId || (this.gameState as any)?.customMapId || null;

    if (mapInfoEl && mapNameEl) {
      mapInfoEl.style.display = 'block';
      if (customMapId && customMapName) {
        mapNameEl.textContent = customMapName;
      } else if (customMapId) {
        mapNameEl.textContent = '自定义地图';
      } else {
        mapNameEl.textContent = '🎲 随机地图';
      }
    }

    if (mapSettingsEl) {
      if (me?.isHost) {
        mapSettingsEl.style.display = 'block';
        if (mapSelectEl && mapSelectEl.options.length <= 1) {
          await this.populateMapSelect(mapSelectEl, customMapId);
        }
      } else {
        mapSettingsEl.style.display = 'none';
      }
    }
  }

  private async populateMapSelect(
    selectEl: HTMLSelectElement,
    selectedId: string | null
  ) {
    const maps = await fetchMapList(this.network);
    this.cachedMaps = maps;
    const currentVal = selectedId || '';
    selectEl.innerHTML = '<option value="">🎲 随机地图</option>';
    for (const m of maps) {
      const opt = document.createElement('option');
      opt.value = m.mapId;
      opt.textContent = `${m.name} (${m.spawnCount}出生点)`;
      selectEl.appendChild(opt);
    }
    selectEl.value = currentVal;
  }

  private startGameScreen() {
    this.showScreen('game-screen');
    if (!this.renderer) {
      const canvas = document.getElementById('dish-canvas') as HTMLCanvasElement;
      this.renderer = new DishRenderer(canvas);
      this.renderer.setMyPlayerId(this.myPlayerId);

      this.renderer.onClick((pos) => {
        this.handleDishClick(pos);
      });

      this.renderer.onHover((pos) => {
        this.updateSelectedInfo(pos);
      });
    }

    this.renderer.setGameState(this.gameState!);
    this.updateMarkerButtonsVisibility();
    this.updateGameScreen();
    this.addEventsToLog(this.gameState!.eventLog);
  }

  private updateMarkerButtonsVisibility() {
    const markerButtons = document.querySelector('.marker-buttons');
    if (markerButtons && this.gameState) {
      markerButtons.classList.toggle('hidden', this.gameState.status !== 'playing');
    }
  }

  private handleDishClick(pos: Position) {
    if (!this.gameState || !this.renderer) return;

    const me = this.gameState.players.find((p) => p.id === this.myPlayerId);
    if (!me || me.isSpectator || !me.isAlive) return;

    if (this.markerMode) {
      this.handleMarkerPlacement(pos);
      return;
    }

    const colony = this.renderer.getColonyAt(pos);

    if (this.selectedColonyId) {
      if (colony && colony.playerId === this.myPlayerId && colony.id === this.selectedColonyId) {
        this.selectedColonyId = null;
        this.renderer.setSelectedColony(null);
        return;
      }

      this.submitPlayerAction(pos);
      this.selectedColonyId = null;
      this.renderer.setSelectedColony(null);
      return;
    }

    if (colony && colony.playerId === this.myPlayerId) {
      this.selectedColonyId = colony.id;
      this.renderer.setSelectedColony(colony.id);
    }
  }

  private handleMarkerPlacement(pos: Position) {
    if (!this.markerMode) return;
    this.network.send({
      type: 'place_marker',
      payload: {
        roomId: this.roomId,
        markerType: this.markerMode,
        position: pos,
      },
    });
    this.markerMode = null;
    if (this.renderer) {
      this.renderer.setMarkerMode(null);
    }
    document.querySelectorAll('.btn-marker').forEach((b) => {
      (b as HTMLElement).classList.remove('active');
    });
    this.setCurrentAction(this.currentAction);
  }

  private submitPlayerAction(targetPos: Position) {
    if (!this.selectedColonyId || !this.gameState) return;

    const colony = this.gameState.colonies.find((c) => c.id === this.selectedColonyId);
    if (!colony || colony.playerId !== this.myPlayerId) return;

    if (this.currentAction === 'evolve') {
      return;
    }

    const dist = Math.sqrt(
      Math.pow(targetPos.x - colony.position.x, 2) +
        Math.pow(targetPos.y - colony.position.y, 2)
    );

    let maxDist = 2;
    if (this.currentAction === 'spread') {
      maxDist = 5;
    }
    if (dist <= 0 || dist > maxDist) return;

    const action: PlayerAction = {
      playerId: this.myPlayerId,
      actionType: this.currentAction,
      colonyId: this.selectedColonyId,
      targetPosition: targetPos,
    };

    this.network.send({
      type: 'submit_action',
      payload: {
        roomId: this.roomId,
        action,
      },
    });

    if (this.renderer) {
      const me = this.gameState.players.find((p) => p.id === this.myPlayerId);
      this.renderer.addAnimation({
        type: this.currentAction === 'attack' ? 'attack' : 'spread',
        position: targetPos,
        color: me?.color || '#fff',
        startTime: Date.now(),
        duration: 600,
      });
    }
  }

  private setCurrentAction(action: ActionType) {
    this.currentAction = action;
    this.markerMode = null;
    if (this.renderer) {
      this.renderer.setMarkerMode(null);
    }
    document.querySelectorAll('.btn-marker').forEach((b) => {
      (b as HTMLElement).classList.remove('active');
    });
    document.querySelectorAll('.btn-action').forEach((b) => {
      const el = b as HTMLElement;
      el.classList.toggle('active', el.dataset.action === action);
    });
    if (this.renderer) {
      this.renderer.setCurrentAction(action);
    }
  }

  private updateSelectedInfo(pos: Position | null) {
    const info = document.getElementById('selected-info');
    if (!info) return;

    if (!this.renderer || !this.gameState) {
      info.textContent = '点击培养皿选择菌落';
      return;
    }

    if (this.markerMode) {
      const markerName = this.markerMode === 'danger' ? '危险区' : this.markerMode === 'target' ? '目标区' : '防御区';
      info.textContent = `标记模式: ${markerName} - 点击格子放置标记`;
      return;
    }

    let text = '点击培养皿选择菌落';

    if (this.selectedColonyId) {
      const colony = this.gameState.colonies.find((c) => c.id === this.selectedColonyId);
      if (colony) {
        const player = this.gameState.players.find((p) => p.id === colony.playerId);
        const actionName =
          this.currentAction === 'spread' ? '扩散到' : this.currentAction === 'attack' ? '攻击' : '进化作用于';
        if (pos) {
          const targetColony = this.renderer.getColonyAt(pos);
          text = `已选 ${MICROBE_NAMES[colony.microbeType]} - ${actionName} (${pos.x},${pos.y})`;
          if (targetColony) {
            const tp = this.gameState.players.find((p) => p.id === targetColony.playerId);
            text += ` [${tp?.name || '?'}`;
          }
        } else {
          text = `已选菌落 [${player?.name}] 生物量:${Math.round(colony.biomass)} - 选择目标格`;
        }
      }
    } else if (pos) {
      const colony = this.renderer.getColonyAt(pos);
      if (colony) {
        const player = this.gameState.players.find((p) => p.id === colony.playerId);
        text = `${player?.name || '?'}的${MICROBE_NAMES[colony.microbeType]} (生物量:${Math.round(colony.biomass)})`;
        if (colony.biofilmLayers > 0) text += ` [生物膜x${colony.biofilmLayers}]`;
      } else {
        const cell = this.gameState.grid[pos.y]?.[pos.x];
        if (cell) {
          text = `空地 (${pos.x},${pos.y}) 营养:${(cell.environment.nutrient * 100).toFixed(0)}% 温度:${cell.environment.temperature.toFixed(0)}°C`;
        }
      }
    }

    info.textContent = text;
  }

  private updateGameScreen() {
    if (!this.gameState || !this.renderer) return;

    this.renderer.setGameState(this.gameState);

    document.getElementById('current-turn')!.textContent = String(this.gameState.turn);
    (document.querySelector('.turn-max') as HTMLElement).textContent = String(
      this.gameState.maxTurns
    );

    const statusEl = document.getElementById('game-status');
    if (statusEl) {
      if (this.gameState.status === 'finished') {
        statusEl.textContent = '游戏结束';
      } else if (this.submitted) {
        statusEl.textContent = '已提交回合，等待其他玩家...';
      } else {
        statusEl.textContent = '规划你的操作，然后结束回合';
      }
    }

    this.updateMarkerButtonsVisibility();

    this.updatePlayerStats();
    this.updateSubmitStatus();
    this.updateActionButtonsState();
  }

  private isAlliedWith(playerId: string): boolean {
    return this.alliances.some(
      (a) =>
        (a.playerId1 === this.myPlayerId && a.playerId2 === playerId) ||
        (a.playerId1 === playerId && a.playerId2 === this.myPlayerId)
    );
  }

  private updatePlayerStats() {
    if (!this.gameState) return;
    const statsEl = document.getElementById('player-stats');
    if (!statsEl) return;

    const sorted = [...this.gameState.players].sort((a, b) => {
      const aSpec = a.isSpectator ? 1 : 0;
      const bSpec = b.isSpectator ? 1 : 0;
      if (aSpec !== bSpec) return aSpec - bSpec;
      return b.weightedArea - a.weightedArea;
    });

    statsEl.innerHTML = sorted
      .map((p, idx) => {
        const me = p.id === this.myPlayerId ? ' (你)' : '';
        const bar = p.isSpectator
          ? 0
          : Math.min(100, p.weightedArea);
        const isAllied = this.isAlliedWith(p.id);
        const canRequestAlliance = !p.isSpectator && p.id !== this.myPlayerId && p.isAlive && !isAllied;
        const myAllianceCount = this.alliances.filter(
          (a) => a.playerId1 === this.myPlayerId || a.playerId2 === this.myPlayerId
        ).length;
        const allyCount = this.alliances.filter(
          (a) => a.playerId1 === p.id || a.playerId2 === p.id
        ).length;
        return `
        <div class="stat-item ${p.id === this.myPlayerId ? 'me' : ''}">
          <div class="stat-row">
            <span class="stat-rank">#${idx + 1}</span>
            <span class="stat-color" style="background:${p.color}"></span>
            <span class="stat-name">${this.escapeHtml(p.name)}${me}${isAllied ? ' 🤝' : ''}</span>
            <span class="stat-badge badge-type">${MICROBE_NAMES[p.microbeType].split(' ')[0]}</span>
          </div>
          <div class="stat-row stat-area">
            <span>面积: ${p.totalArea}</span>
            <span>加权: ${p.weightedArea.toFixed(1)}</span>
            ${canRequestAlliance && myAllianceCount < 2 && allyCount < 2 ? `<button class="btn-alliance" data-target-id="${p.id}">结盟</button>` : ''}
          </div>
          ${!p.isSpectator ? `
          <div class="stat-bar">
            <div class="stat-bar-fill" style="width:${bar}%;background:${p.color}"></div>
          </div>
          ` : ''}
          ${p.isSpectator ? '<div class="stat-label">观战模式</div>' : ''}
          ${!p.isAlive && !p.isSpectator ? '<div class="stat-label eliminated">已淘汰</div>' : ''}
        </div>
      `;
      })
      .join('');

    statsEl.querySelectorAll('.btn-alliance').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        const targetId = target.dataset.targetId;
        if (targetId) {
          this.network.send({
            type: 'alliance_request',
            payload: {
              roomId: this.roomId,
              targetPlayerId: targetId,
            },
          });
        }
      });
    });
  }

  private updateSubmitStatus() {
    const statusEl = document.getElementById('submit-status');
    const countEl = document.getElementById('ready-count');
    const btn = document.getElementById('btn-submit-turn') as HTMLButtonElement;

    if (!this.gameState) return;

    const nonSpec = this.gameState.players.filter((p) => !p.isSpectator && p.isAlive);
    const submittedCount = nonSpec.filter((p) => p.hasSubmitted).length;

    if (countEl) countEl.textContent = `已就绪: ${submittedCount}/${nonSpec.length}`;

    const me = this.gameState.players.find((p) => p.id === this.myPlayerId);
    const canSubmit = me && !me.isSpectator && me.isAlive;

    if (btn) {
      btn.disabled = !canSubmit || this.submitted;
      btn.textContent = this.submitted ? '已提交' : '结束回合';
    }

    if (statusEl) {
      if (!canSubmit) {
        statusEl.textContent = me?.isSpectator
          ? '观战中，无需提交'
          : '你已被淘汰';
      } else if (this.submitted) {
        statusEl.textContent = '等待其他玩家...';
      } else {
        statusEl.textContent = '选择并确认你的操作';
      }
    }
  }

  private updateActionButtonsState() {
    if (!this.gameState) return;
    const me = this.gameState.players.find((p) => p.id === this.myPlayerId);
    const disabled = !me || me.isSpectator || !me.isAlive || this.submitted;
    document.querySelectorAll('.btn-action').forEach((b) => {
      (b as HTMLButtonElement).disabled = disabled;
    });
    document.querySelectorAll('.btn-marker').forEach((b) => {
      (b as HTMLButtonElement).disabled = disabled;
    });
  }

  private playTurnAnimations(events: EventLogEntry[]) {
    if (!this.renderer || !this.gameState) return;

    for (const ev of events) {
      if (ev.type === 'attack' && ev.playerId) {
        const player = this.gameState.players.find((p) => p.id === ev.playerId);
        const colonies = this.gameState.colonies.filter((c) => c.playerId === ev.playerId);
        if (colonies.length > 0) {
          const c = colonies[Math.floor(Math.random() * colonies.length)];
          this.renderer.addAnimation({
            type: 'attack',
            position: c.position,
            color: player?.color || '#ff4444',
            startTime: Date.now() + Math.random() * 300,
            duration: 700,
          });
        }
      } else if (ev.type === 'mutation' && ev.playerId) {
        const colonies = this.gameState.colonies.filter((c) => c.playerId === ev.playerId);
        if (colonies.length > 0) {
          const c = colonies[Math.floor(Math.random() * colonies.length)];
          this.renderer.addAnimation({
            type: 'mutation',
            position: c.position,
            color: '#b030ff',
            startTime: Date.now() + Math.random() * 400,
            duration: 1000,
          });
        }
      }
    }

    this.addEventsToLog(events);
  }

  private addEventsToLog(events: EventLogEntry[]) {
    const logEl = document.getElementById('event-log');
    if (!logEl) return;

    for (const ev of events) {
      const div = document.createElement('div');
      div.className = `log-entry log-${ev.type}`;
      div.textContent = `[回合${ev.turn}] ${ev.message}`;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    }

    while (logEl.children.length > 100) {
      logEl.removeChild(logEl.firstChild!);
    }
  }

  private showResultScreen() {
    if (!this.gameState) return;
    this.showScreen('result-screen');

    const titleEl = document.getElementById('result-title');
    const rankingEl = document.getElementById('result-ranking');
    if (!titleEl || !rankingEl) return;

    const winner = this.gameState.players.find((p) => p.id === this.gameState!.winnerId);
    const me = this.gameState.players.find((p) => p.id === this.myPlayerId);

    if (winner) {
      if (winner.id === this.myPlayerId) {
        titleEl.textContent = '🏆 你赢了！';
      } else {
        titleEl.textContent = `${winner.name} 获得胜利！`;
      }
    }

    const sorted = [...this.gameState.rankings];
    rankingEl.innerHTML = sorted
      .map((r, idx) => {
        const player = this.gameState!.players.find((p) => p.id === r.playerId);
        if (!player) return '';
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
        const meMark = player.id === this.myPlayerId ? ' (你)' : '';
        const isAllied = this.isAlliedWith(player.id);
        return `
        <div class="rank-item rank-${idx} ${player.id === this.myPlayerId ? 'me' : ''}">
          <span class="rank-medal">${medal}</span>
          <span class="rank-color" style="background:${player.color}"></span>
          <span class="rank-name">${this.escapeHtml(player.name)}${meMark}${isAllied ? ' 🤝' : ''}</span>
          <span class="rank-microbe">${MICROBE_NAMES[player.microbeType]}</span>
          <span class="rank-area">领地: ${r.area}</span>
          <span class="rank-weighted">加权: ${r.weightedArea.toFixed(1)}</span>
        </div>
      `;
      })
      .join('');

    if (this.latestStats) {
      this.renderStatsPanel(this.latestStats);
    }
  }

  private renderStatsPanel(stats: GameStats) {
    const globalStatsEl = document.getElementById('global-stats');
    const playerStatsEl = document.getElementById('player-stats-detail');
    if (!globalStatsEl || !playerStatsEl) return;

    globalStatsEl.innerHTML = `
      <div class="global-stat-item">
        <span class="stat-label">总回合数</span>
        <span class="stat-value">${stats.totalTurns}</span>
      </div>
      <div class="global-stat-item">
        <span class="stat-label">最激烈回合</span>
        <span class="stat-value">第${stats.mostViolentTurn.turn}回合 (击杀${stats.mostViolentTurn.killCount}个)</span>
      </div>
      <div class="global-stat-item mvp">
        <span class="stat-label">👑 MVP</span>
        <span class="stat-value">
          ${stats.mvp ? `${stats.mvp.playerName} (${stats.mvp.score.toFixed(1)}分)` : '暂无'}
        </span>
      </div>
    `;

    playerStatsEl.innerHTML = stats.playerStats
      .map((ps) => `
      <div class="player-stat-card" style="border-left: 4px solid ${ps.playerColor}">
        <div class="player-stat-header">
          <span class="player-stat-name" style="color:${ps.playerColor}">
            ${this.escapeHtml(ps.playerName)}
          </span>
          <span class="player-stat-rank">#${ps.finalRank}</span>
        </div>
        <div class="player-stat-grid">
          <div class="stat-cell">
            <span class="stat-cell-label">扩散</span>
            <span class="stat-cell-value">${ps.totalSpreadCount}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell-label">攻击</span>
            <span class="stat-cell-value">${ps.totalAttackCount}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell-label">进化</span>
            <span class="stat-cell-value">${ps.totalEvolveCount}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell-label">击杀</span>
            <span class="stat-cell-value kill">${ps.kills}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell-label">被击杀</span>
            <span class="stat-cell-value death">${ps.deaths}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell-label">最大领地</span>
            <span class="stat-cell-value">${ps.maxAreaPeak}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell-label">存活回合</span>
            <span class="stat-cell-value">${ps.survivalTurns}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell-label">结盟</span>
            <span class="stat-cell-value">${ps.allianceCount}</span>
          </div>
          <div class="stat-cell">
            <span class="stat-cell-label">背叛</span>
            <span class="stat-cell-value betrayal">${ps.betrayalCount}</span>
          </div>
        </div>
      </div>
    `)
    .join('');

    this.drawAreaChart(stats);
  }

  private drawAreaChart(stats: GameStats) {
    const canvas = document.getElementById('area-chart-canvas') as HTMLCanvasElement;
    if (!canvas || !stats.areaHistory.length) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const padding = { top: 30, right: 20, bottom: 40, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    ctx.clearRect(0, 0, width, height);

    const maxTurn = Math.max(...stats.areaHistory.map((h) => h.turn));
    const maxArea = Math.max(
      ...stats.areaHistory.flatMap((h) => Object.values(h.areas))
    );

    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = padding.top + (chartHeight / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      const value = Math.round(maxArea - (maxArea / 5) * i);
      ctx.fillStyle = '#666';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(value), padding.left - 10, y + 4);
    }

    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.stroke();

    const players = stats.playerStats.map((ps) => ({
      id: ps.playerId,
      name: ps.playerName,
      color: ps.playerColor,
    }));

    for (const player of players) {
      ctx.beginPath();
      ctx.strokeStyle = player.color;
      ctx.lineWidth = 2;

      let started = false;
      for (let i = 0; i < stats.areaHistory.length; i++) {
        const history = stats.areaHistory[i];
        const area = history.areas[player.id] || 0;
        const x = padding.left + (history.turn / maxTurn) * chartWidth;
        const y = padding.top + chartHeight - (area / maxArea) * chartHeight;

        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      const lastHistory = stats.areaHistory[stats.areaHistory.length - 1];
      const lastArea = lastHistory.areas[player.id] || 0;
      const lastX = padding.left + (lastHistory.turn / maxTurn) * chartWidth;
      const lastY = padding.top + chartHeight - (lastArea / maxArea) * chartHeight;

      ctx.beginPath();
      ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
    }

    ctx.fillStyle = '#333';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i <= maxTurn; i += Math.ceil(maxTurn / 10)) {
      const x = padding.left + (i / maxTurn) * chartWidth;
      ctx.fillText(String(i), x, height - padding.bottom + 20);
    }

    ctx.fillText('回合数', width / 2, height - 10);
    ctx.save();
    ctx.translate(15, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('领地格子数', 0, 0);
    ctx.restore();

    const legendX = padding.left + 10;
    let legendY = padding.top + 10;
    for (const player of players) {
      ctx.fillStyle = player.color;
      ctx.fillRect(legendX, legendY, 12, 12);
      ctx.fillStyle = '#333';
      ctx.textAlign = 'left';
      ctx.fillText(player.name, legendX + 20, legendY + 10);
      legendY += 20;
    }
  }

  private escapeHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  private requestReplayByRoomId(roomId: string) {
    this.network.send({
      type: 'request_replay',
      payload: { roomId },
    });
  }

  private requestReplayById(replayId: string) {
    this.network.send({
      type: 'request_replay',
      payload: { replayId },
    });
  }

  private shareReplay() {
    if (!this.currentReplay) return;
    const url = `${window.location.origin}${window.location.pathname}?replay=${this.currentReplay.replayId}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(
        () => {
          this.showToast(`回放链接已复制: ${this.currentReplay!.replayId}`);
        },
        () => {
          this.copyFallback(url);
        }
      );
    } else {
      this.copyFallback(url);
    }
  }

  private copyFallback(text: string) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      this.showToast('回放链接已复制到剪贴板');
    } catch {
      this.showToast(`复制失败，请手动复制: ${text}`, true);
    }
    document.body.removeChild(textarea);
  }

  private showToast(message: string, isError: boolean = false) {
    const toast = document.createElement('div');
    toast.className = 'toast-notification ' + (isError ? 'error' : 'success');
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  private exportReplayData() {
    if (!this.currentReplay) return;
    const r = this.currentReplay;
    const startDate = new Date(r.startTime);
    const dateStr = `${startDate.getFullYear()}${(startDate.getMonth() + 1)
      .toString()
      .padStart(2, '0')}${startDate.getDate().toString().padStart(2, '0')}${startDate
      .getHours()
      .toString()
      .padStart(2, '0')}${startDate.getMinutes().toString().padStart(2, '0')}`;
    const safeRoomName = r.roomName.replace(/[\\/:*?"<>|]/g, '_');
    const filename = `回放_${safeRoomName}_${dateStr}.json`;

    const exportData = {
      gameInfo: {
        replayId: r.replayId,
        roomId: r.roomId,
        roomName: r.roomName,
        gameId: r.gameId,
        startTime: new Date(r.startTime).toLocaleString('zh-CN'),
        endTime: new Date(r.endTime).toLocaleString('zh-CN'),
        startTimeMs: r.startTime,
        endTimeMs: r.endTime,
        totalTurns: r.stats.totalTurns,
        maxTurns: r.maxTurns,
        gridSize: r.gridSize,
        playerCount: r.players.filter((p) => !p.isSpectator).length,
      },
      mvp: r.stats.mvp,
      playerStats: r.stats.playerStats,
      areaHistory: r.stats.areaHistory,
      finalRankings: r.finalRankings,
      winnerId: r.winnerId,
      winnerName:
        r.players.find((p) => p.id === r.winnerId)?.name || null,
      highlights: r.highlights || [],
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
    this.showToast('回放数据已导出');
  }

  private startReplayPlayer() {
    if (!this.currentReplay) return;

    this.showScreen('replay-screen');

    if (!this.replayRenderer) {
      const canvas = document.getElementById('replay-canvas') as HTMLCanvasElement;
      this.replayRenderer = new DishRenderer(canvas);
      this.replayRenderer.setMyPlayerId('');
    }

    const roomNameEl = document.getElementById('replay-room-name');
    const turnInfoEl = document.getElementById('replay-turn-info');
    const progressEl = document.getElementById('replay-progress') as HTMLInputElement;
    const replayIdEl = document.getElementById('replay-id-display');

    if (roomNameEl) roomNameEl.textContent = this.currentReplay.roomName;
    if (turnInfoEl) {
      turnInfoEl.textContent = `回合: 0 / ${this.currentReplay.stats.totalTurns}`;
    }
    if (replayIdEl) {
      replayIdEl.textContent = `ID: ${this.currentReplay.replayId}`;
      replayIdEl.title = '点击复制回放ID';
      replayIdEl.style.cursor = 'pointer';
      replayIdEl.onclick = () => {
        if (this.currentReplay) {
          navigator.clipboard?.writeText(this.currentReplay.replayId).then(() => {
            this.showToast('回放ID已复制');
          });
        }
      };
    }
    if (progressEl) {
      progressEl.max = String(this.currentReplay.stats.totalTurns);
      progressEl.value = '0';
    }

    this.renderHighlightsPanel();
    this.renderHighlightsOnProgress();

    this.replayTurn = 0;
    this.isPlaying = false;
    this.updatePlayButton();
    this.renderReplayTurn(0);
    this.updateReplayChat(0);

    if (this.pendingCompareReplayId) {
      setTimeout(() => {
        this.toggleCompareMode();
        (document.getElementById('compare-replay-id-input') as HTMLInputElement)!.value =
          this.pendingCompareReplayId;
        this.loadCompareReplay(this.pendingCompareReplayId);
        this.pendingCompareReplayId = '';
      }, 300);
    }
  }

  private renderHighlightsPanel() {
    const panel = document.getElementById('replay-highlights-panel');
    if (!panel || !this.currentReplay) return;

    const highlights = this.currentReplay.highlights || [];
    if (highlights.length === 0) {
      panel.innerHTML = '<div class="replay-event-empty">暂无精彩片段</div>';
      return;
    }

    const iconMap: Record<string, string> = {
      multi_kill: '⚔️',
      territory_surge: '🌱',
      betrayal: '💔',
    };

    panel.innerHTML = highlights
      .map(
        (h, idx) => `
        <div class="highlight-item" data-index="${idx}" data-type="${h.type}" data-turn="${h.turn}">
          <div class="highlight-icon">${iconMap[h.type] || '✨'}</div>
          <div class="highlight-content">
            <div class="highlight-title">
              <span class="highlight-turn">第${h.turn}回合</span>
              <span class="highlight-type highlight-type-${h.type}">${
          h.type === 'multi_kill'
            ? '多杀'
            : h.type === 'territory_surge'
            ? '领地暴涨'
            : '联盟背叛'
        }</span>
            </div>
            <div class="highlight-desc">${this.escapeHtml(h.description)}</div>
          </div>
        </div>
      `
      )
      .join('');

    panel.querySelectorAll('.highlight-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        const turn = parseInt((item as HTMLElement).dataset.turn || '0', 10);
        this.jumpToHighlight(turn);
      });
    });
  }

  private renderHighlightsOnProgress() {
    if (!this.currentReplay) return;
    const trackWrap = document.querySelector(
      '.replay-controls:not(#replay-controls-compare) .replay-progress-track-wrap'
    ) as HTMLElement;
    if (!trackWrap) return;

    const existing = trackWrap.querySelectorAll('.highlight-marker-dot');
    existing.forEach((el) => el.remove());

    const highlights = this.currentReplay.highlights || [];
    const totalTurns = this.currentReplay.stats.totalTurns;
    if (totalTurns <= 0) return;

    for (const h of highlights) {
      const dot = document.createElement('div');
      dot.className = 'highlight-marker-dot';
      const pct = (h.turn / totalTurns) * 100;
      dot.style.left = `calc(${pct}% - 5px)`;
      dot.title = `第${h.turn}回合: ${h.description}`;
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.jumpToHighlight(h.turn);
      });
      trackWrap.appendChild(dot);
    }
  }

  private jumpToHighlight(turn: number) {
    this.stopPlayback();
    this.isPlaying = true;
    this.seekToTurn(turn);
    this.updatePlayButton();
    this.startPlayback();
  }

  private renderReplayTurn(turn: number) {
    if (!this.currentReplay || !this.replayRenderer) return;

    const snapshot = this.currentReplay.turnSnapshots[turn];
    if (!snapshot) return;

    const replayGameState: GameState = {
      id: this.currentReplay.gameId,
      status: 'playing',
      turn: snapshot.turn,
      maxTurns: this.currentReplay.maxTurns,
      gridSize: this.currentReplay.gridSize,
      grid: snapshot.gridSnapshot,
      players: this.currentReplay.players,
      colonies: snapshot.colonies,
      globalEvents: [],
      eventLog: [],
      winnerId: null,
      rankings: [],
    };

    this.replayRenderer.setGameState(replayGameState);

    const markers = this.currentReplay.markers[turn] || [];
    this.replayRenderer.setMarkers(markers);

    const turnInfoEl = document.getElementById('replay-turn-info');
    const progressLabelEl = document.getElementById('replay-progress-label');
    if (turnInfoEl) {
      turnInfoEl.textContent = `回合: ${turn} / ${this.currentReplay.stats.totalTurns}`;
    }
    if (progressLabelEl) {
      progressLabelEl.textContent = String(turn);
    }

    this.updateReplayEventPanel(turn);
    this.updateReplayPlayerStats(snapshot);
  }

  private updateReplayEventPanel(turn: number) {
    const panel = document.getElementById('replay-event-panel');
    if (!panel || !this.currentReplay) return;

    const events = this.currentReplay.turnEvents[turn] || [];
    const actions = this.currentReplay.turnActions.filter((a) => a.turn === turn);
    const alliances = this.currentReplay.allianceEvents.filter((a) => a.turn === turn);

    if (events.length === 0 && actions.length === 0 && alliances.length === 0) {
      panel.innerHTML = '<div class="replay-event-empty">本回合无重大事件</div>';
      return;
    }

    let html = '';

    for (const action of actions) {
      const player = this.currentReplay.players.find((p) => p.id === action.playerId);
      const actionName = action.actionType === 'spread' ? '扩散' : action.actionType === 'attack' ? '攻击' : '进化';
      const targetStr = action.targetPosition
        ? ` (${action.targetPosition.x},${action.targetPosition.y})`
        : '';
      html += `
        <div class="replay-event action">
          <span class="event-player" style="color:${player?.color}">${player?.name}</span>
          <span class="event-action">${actionName}</span>
          <span class="event-target">${targetStr}</span>
        </div>
      `;
    }

    for (const alliance of alliances) {
      const p1 = this.currentReplay.players.find((p) => p.id === alliance.playerId1);
      const p2 = this.currentReplay.players.find((p) => p.id === alliance.playerId2);
      if (alliance.type === 'formed') {
        html += `
          <div class="replay-event alliance">
            🤝 <span style="color:${p1?.color}">${p1?.name}</span> 与
            <span style="color:${p2?.color}">${p2?.name}</span> 结成联盟
          </div>
        `;
      } else {
        const betrayer = this.currentReplay.players.find((p) => p.id === alliance.betrayerId);
        const victim =
          alliance.betrayerId === alliance.playerId1 ? p2 : p1;
        html += `
          <div class="replay-event betrayal">
            💔 <span style="color:${betrayer?.color}">${betrayer?.name}</span> 背叛了
            <span style="color:${victim?.color}">${victim?.name}</span>
          </div>
        `;
      }
    }

    for (const event of events) {
      const typeClass = `type-${event.type}`;
      html += `
        <div class="replay-event ${typeClass}">
          ${event.message}
        </div>
      `;
    }

    panel.innerHTML = html;
  }

  private updateReplayPlayerStats(snapshot: { playerAreas: Record<string, number> }) {
    const statsEl = document.getElementById('replay-player-stats');
    if (!statsEl || !this.currentReplay) return;

    const players = this.currentReplay.players.filter((p) => !p.isSpectator);
    const sorted = [...players].sort((a, b) => {
      const areaA = snapshot.playerAreas[a.id] || 0;
      const areaB = snapshot.playerAreas[b.id] || 0;
      return areaB - areaA;
    });

    statsEl.innerHTML = sorted
      .map((p, idx) => {
        const area = snapshot.playerAreas[p.id] || 0;
        return `
          <div class="replay-stat-item">
            <span class="replay-stat-rank">#${idx + 1}</span>
            <span class="replay-stat-color" style="background:${p.color}"></span>
            <span class="replay-stat-name">${this.escapeHtml(p.name)}</span>
            <span class="replay-stat-area">领地: ${area}</span>
          </div>
        `;
      })
      .join('');
  }

  private updateReplayChat(currentTurn: number) {
    const chatEl = document.getElementById('replay-chat');
    if (!chatEl || !this.currentReplay) return;

    const messages = this.currentReplay.chatMessages.filter((msg) => {
      const msgTurn = this.getTurnForTimestamp(msg.timestamp);
      return msgTurn <= currentTurn;
    });

    chatEl.innerHTML = messages
      .map((msg) => {
        const time = new Date(msg.timestamp);
        const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
        if (msg.isSystem) {
          return `<div class="chat-msg system">${this.escapeHtml(msg.content)}</div>`;
        }
        return `
          <div class="chat-msg">
            <span class="chat-msg-name" style="color:${msg.playerColor}">${this.escapeHtml(msg.playerName)}</span>
            ${this.escapeHtml(msg.content)}
            <span class="chat-msg-time">${timeStr}</span>
          </div>
        `;
      })
      .join('');

    chatEl.scrollTop = chatEl.scrollHeight;
  }

  private getTurnForTimestamp(timestamp: number): number {
    if (!this.currentReplay) return 0;
    const duration = this.currentReplay.endTime - this.currentReplay.startTime;
    const totalTurns = this.currentReplay.stats.totalTurns;
    const elapsed = timestamp - this.currentReplay.startTime;
    return Math.min(totalTurns, Math.max(0, Math.floor((elapsed / duration) * totalTurns)));
  }

  private toggleReplayPlay() {
    this.isPlaying = !this.isPlaying;
    this.updatePlayButton();

    if (this.isPlaying) {
      this.startPlayback();
    } else {
      this.stopPlayback();
    }
  }

  private updatePlayButton() {
    const iconEl = document.getElementById('replay-play-icon');
    const textEl = document.getElementById('replay-play-text');
    if (iconEl) iconEl.textContent = this.isPlaying ? '⏸' : '▶';
    if (textEl) textEl.textContent = this.isPlaying ? '暂停' : '播放';
  }

  private startPlayback() {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
    }

    const baseInterval = 1000;
    const interval = baseInterval / this.playbackSpeed;

    this.playbackTimer = window.setInterval(() => {
      if (!this.currentReplay) return;

      if (this.replayTurn >= this.currentReplay.stats.totalTurns) {
        this.stopPlayback();
        this.isPlaying = false;
        this.updatePlayButton();
        return;
      }

      this.replayTurn++;
      this.seekToTurn(this.replayTurn);
    }, interval);
  }

  private stopPlayback() {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  private setPlaybackSpeed(speed: number) {
    this.playbackSpeed = speed;

    document.querySelectorAll('.btn-speed').forEach((btn) => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', parseInt(el.dataset.speed || '1', 10) === speed);
    });

    if (this.isPlaying) {
      this.stopPlayback();
      this.startPlayback();
    }
  }

  private seekToTurn(turn: number) {
    if (!this.currentReplay) return;

    this.replayTurn = Math.max(0, Math.min(turn, this.currentReplay.stats.totalTurns));

    const progressEl = document.getElementById('replay-progress') as HTMLInputElement;
    if (progressEl) {
      progressEl.value = String(this.replayTurn);
    }

    this.renderReplayTurn(this.replayTurn);
    this.updateReplayChat(this.replayTurn);
  }

  private stopReplay() {
    this.stopPlayback();
    this.isPlaying = false;
    if (this.replayRenderer) {
      this.replayRenderer.destroy();
      this.replayRenderer = null;
    }
    this.stopComparePlayback();
    this.compareIsPlaying = false;
    if (this.replayRendererLeft) {
      this.replayRendererLeft.destroy();
      this.replayRendererLeft = null;
    }
    if (this.replayRendererRight) {
      this.replayRendererRight.destroy();
      this.replayRendererRight = null;
    }
    this.compareReplayLeft = null;
    this.compareReplayRight = null;
    this.compareMode = false;
  }

  private toggleCompareMode() {
    if (!this.currentReplay) return;
    this.compareMode = !this.compareMode;
    if (this.compareMode) {
      this.enterCompareMode();
    } else {
      this.exitCompareMode();
    }
  }

  private enterCompareMode() {
    this.compareReplayLeft = this.currentReplay;
    this.stopPlayback();
    this.isPlaying = false;
    this.updatePlayButton();

    (document.getElementById('replay-main-normal') as HTMLElement)!.style.display =
      'none';
    (document.getElementById('replay-main-compare') as HTMLElement)!.style.display =
      'flex';
    (document.getElementById('replay-controls-normal') as HTMLElement)!.style.display =
      'none';
    (document.getElementById('replay-controls-compare') as HTMLElement)!.style.display =
      'flex';
    (document.getElementById('replay-compare-bar') as HTMLElement)!.style.display =
      'flex';

    if (!this.replayRendererLeft) {
      const canvasLeft = document.getElementById('replay-canvas-left') as HTMLCanvasElement;
      this.replayRendererLeft = new DishRenderer(canvasLeft);
      this.replayRendererLeft.setMyPlayerId('');
    }
    if (!this.replayRendererRight) {
      const canvasRight = document.getElementById('replay-canvas-right') as HTMLCanvasElement;
      this.replayRendererRight = new DishRenderer(canvasRight);
      this.replayRendererRight.setMyPlayerId('');
    }

    const leftNameEl = document.getElementById('compare-left-name') as HTMLElement;
    leftNameEl.textContent = this.compareReplayLeft!.roomName;

    const progressLeft = document.getElementById('replay-progress-left') as HTMLInputElement;
    if (progressLeft) {
      progressLeft.max = String(this.compareReplayLeft!.stats.totalTurns);
      progressLeft.value = '0';
    }

    this.compareProgressRatio = 0;
    this.renderCompareProgress(this.compareProgressRatio);
    this.updateComparePlayButton();

    if (!this.compareReplayRight) {
      const rightNameEl = document.getElementById('compare-right-name') as HTMLElement;
      rightNameEl.textContent = '请输入回放ID加载';
    }
  }

  private exitCompareMode() {
    this.stopComparePlayback();
    this.compareIsPlaying = false;
    this.updateComparePlayButton();

    (document.getElementById('replay-main-normal') as HTMLElement)!.style.display =
      'flex';
    (document.getElementById('replay-main-compare') as HTMLElement)!.style.display =
      'none';
    (document.getElementById('replay-controls-normal') as HTMLElement)!.style.display =
      'flex';
    (document.getElementById('replay-controls-compare') as HTMLElement)!.style.display =
      'none';
    (document.getElementById('replay-compare-bar') as HTMLElement)!.style.display =
      'none';

    this.compareMode = false;
    this.compareReplayRight = null;

    if (this.replayRendererLeft) {
      this.replayRendererLeft.destroy();
      this.replayRendererLeft = null;
    }
    if (this.replayRendererRight) {
      this.replayRendererRight.destroy();
      this.replayRendererRight = null;
    }
  }

  private loadCompareReplay(replayId: string) {
    this.pendingCompareReplayId = '';
    this.network.send({
      type: 'request_replay',
      payload: { replayId },
    });

    const originalHandler = (payload: ReplayData) => {
      if (this.compareMode) {
        this.compareReplayRight = payload;
        const rightNameEl = document.getElementById('compare-right-name') as HTMLElement;
        rightNameEl.textContent = this.compareReplayRight.roomName;

        const progressRight = document.getElementById('replay-progress-right') as HTMLInputElement;
        if (progressRight) {
          progressRight.max = String(this.compareReplayRight.stats.totalTurns);
          progressRight.value = '0';
        }

        this.renderCompareProgress(this.compareProgressRatio);
        this.showToast('对比回放加载成功');
        this.network.off('replay_data', originalHandler);
      }
    };
    this.network.on('replay_data', originalHandler);

    setTimeout(() => {
      this.network.off('replay_data', originalHandler);
    }, 5000);
  }

  private getCompareReferenceTurns(): number {
    const maxL = this.compareReplayLeft?.stats.totalTurns || 0;
    const maxR = this.compareReplayRight?.stats.totalTurns || 0;
    return Math.max(maxL, maxR);
  }

  private ratioToTurn(ratio: number, totalTurns: number): number {
    return Math.max(0, Math.min(Math.round(ratio * totalTurns), totalTurns));
  }

  private renderCompareProgress(ratio: number) {
    this.compareProgressRatio = Math.max(0, Math.min(ratio, 1));

    const maxLeft = this.compareReplayLeft?.stats.totalTurns || 0;
    const turnLeft = this.ratioToTurn(this.compareProgressRatio, maxLeft);
    if (this.compareReplayLeft && this.replayRendererLeft) {
      const snapshot = this.compareReplayLeft.turnSnapshots[turnLeft];
      if (snapshot) {
        const gs: GameState = {
          id: this.compareReplayLeft.gameId,
          status: 'playing',
          turn: snapshot.turn,
          maxTurns: this.compareReplayLeft.maxTurns,
          gridSize: this.compareReplayLeft.gridSize,
          grid: snapshot.gridSnapshot,
          players: this.compareReplayLeft.players,
          colonies: snapshot.colonies,
          globalEvents: [],
          eventLog: [],
          winnerId: null,
          rankings: [],
        };
        this.replayRendererLeft.setGameState(gs);
        const markers = this.compareReplayLeft.markers[turnLeft] || [];
        this.replayRendererLeft.setMarkers(markers);
      }
      const labelLeft = document.getElementById('replay-progress-label-left') as HTMLElement;
      if (labelLeft) labelLeft.textContent = String(turnLeft);
      const progressLeft = document.getElementById('replay-progress-left') as HTMLInputElement;
      if (progressLeft) progressLeft.value = String(turnLeft);
    }

    const maxRight = this.compareReplayRight?.stats.totalTurns || 0;
    const turnRight = this.ratioToTurn(this.compareProgressRatio, maxRight);
    if (this.compareReplayRight && this.replayRendererRight) {
      const snapshot = this.compareReplayRight.turnSnapshots[turnRight];
      if (snapshot) {
        const gs: GameState = {
          id: this.compareReplayRight.gameId,
          status: 'playing',
          turn: snapshot.turn,
          maxTurns: this.compareReplayRight.maxTurns,
          gridSize: this.compareReplayRight.gridSize,
          grid: snapshot.gridSnapshot,
          players: this.compareReplayRight.players,
          colonies: snapshot.colonies,
          globalEvents: [],
          eventLog: [],
          winnerId: null,
          rankings: [],
        };
        this.replayRendererRight.setGameState(gs);
        const markers = this.compareReplayRight.markers[turnRight] || [];
        this.replayRendererRight.setMarkers(markers);
      }
      const labelRight = document.getElementById('replay-progress-label-right') as HTMLElement;
      if (labelRight) labelRight.textContent = String(turnRight);
      const progressRight = document.getElementById('replay-progress-right') as HTMLInputElement;
      if (progressRight) progressRight.value = String(turnRight);
    }

    this.renderDiffSummary(turnLeft, turnRight);
  }

  private renderDiffSummary(turnL: number, turnR: number) {
    const panel = document.getElementById('replay-diff-summary') as HTMLElement;
    if (!panel) return;
    if (!this.compareReplayLeft || !this.compareReplayRight) {
      panel.innerHTML = '<div class="replay-event-empty">请先加载两场回放</div>';
      return;
    }

    const snapL = this.compareReplayLeft.turnSnapshots[turnL];
    const snapR = this.compareReplayRight.turnSnapshots[turnR];
    if (!snapL || !snapR) {
      panel.innerHTML = '<div class="replay-event-empty">无数据</div>';
      return;
    }

    const totalAreaL = Object.values(snapL.playerAreas).reduce((a, b) => a + b, 0);
    const totalAreaR = Object.values(snapR.playerAreas).reduce((a, b) => a + b, 0);
    const aliveCountL = Object.keys(snapL.playerAreas).filter(
      (pid) => (snapL.playerAreas[pid] || 0) > 0
    ).length;
    const aliveCountR = Object.keys(snapR.playerAreas).filter(
      (pid) => (snapR.playerAreas[pid] || 0) > 0
    ).length;

    const eventsL = this.compareReplayLeft.turnEvents[turnL] || [];
    const eventsR = this.compareReplayRight.turnEvents[turnR] || [];
    const killCount = (events: EventLogEntry[]) =>
      events.filter(
        (e) =>
          (e.type === 'attack' && e.message.includes('击败')) ||
          e.type === 'elimination'
      ).length;
    const killsL = killCount(eventsL);
    const killsR = killCount(eventsR);

    const areaDiff = totalAreaL - totalAreaR;
    const killDiff = killsL - killsR;
    const aliveDiff = aliveCountL - aliveCountR;

    const diffStr = (diff: number) => {
      if (diff > 0) return `<span style="color:var(--success)">+${diff}</span>`;
      if (diff < 0) return `<span style="color:var(--danger)">${diff}</span>`;
      return `<span style="color:var(--text-muted)">0</span>`;
    };

    panel.innerHTML = `
      <div class="diff-current-turn">
        <span>A回合 <strong>${turnL}</strong> / B回合 <strong>${turnR}</strong></span>
      </div>
      <div class="diff-row">
        <span class="diff-label">总领地数差</span>
        <span class="diff-values">A: ${totalAreaL} / B: ${totalAreaR}</span>
        <span class="diff-badge">${diffStr(areaDiff)}</span>
      </div>
      <div class="diff-row">
        <span class="diff-label">本回合击杀差</span>
        <span class="diff-values">A: ${killsL} / B: ${killsR}</span>
        <span class="diff-badge">${diffStr(killDiff)}</span>
      </div>
      <div class="diff-row">
        <span class="diff-label">活跃玩家数差</span>
        <span class="diff-values">A: ${aliveCountL} / B: ${aliveCountR}</span>
        <span class="diff-badge">${diffStr(aliveDiff)}</span>
      </div>
      <div class="diff-player-section">
        <div class="diff-player-subtitle">A - 玩家领地</div>
        ${this.renderComparePlayerList(this.compareReplayLeft, snapL)}
      </div>
      <div class="diff-player-section">
        <div class="diff-player-subtitle">B - 玩家领地</div>
        ${this.renderComparePlayerList(this.compareReplayRight, snapR)}
      </div>
    `;
  }

  private renderComparePlayerList(
    replay: ReplayData,
    snap: { playerAreas: Record<string, number> }
  ) {
    const players = replay.players.filter((p) => !p.isSpectator);
    const sorted = [...players].sort((a, b) => {
      const aa = snap.playerAreas[a.id] || 0;
      const bb = snap.playerAreas[b.id] || 0;
      return bb - aa;
    });
    return sorted
      .map(
        (p, idx) => `
        <div class="diff-player-row">
          <span class="diff-rank">#${idx + 1}</span>
          <span class="diff-player-color" style="background:${p.color}"></span>
          <span class="diff-player-name">${this.escapeHtml(p.name)}</span>
          <span class="diff-player-area">${snap.playerAreas[p.id] || 0}</span>
        </div>
      `
      )
      .join('');
  }

  private seekCompareTurn(turn: number, source: 'left' | 'right') {
    const totalTurns =
      source === 'left'
        ? this.compareReplayLeft?.stats.totalTurns || 1
        : this.compareReplayRight?.stats.totalTurns || 1;
    const ratio = turn / totalTurns;
    this.renderCompareProgress(ratio);
  }

  private toggleComparePlay() {
    this.compareIsPlaying = !this.compareIsPlaying;
    this.updateComparePlayButton();
    if (this.compareIsPlaying) {
      this.startComparePlayback();
    } else {
      this.stopComparePlayback();
    }
  }

  private updateComparePlayButton() {
    const iconEl = document.getElementById('replay-play-icon-compare') as HTMLElement;
    const textEl = document.getElementById('replay-play-text-compare') as HTMLElement;
    if (iconEl) iconEl.textContent = this.compareIsPlaying ? '⏸' : '▶';
    if (textEl) textEl.textContent = this.compareIsPlaying ? '暂停' : '播放';
  }

  private startComparePlayback() {
    if (this.comparePlaybackTimer) {
      clearInterval(this.comparePlaybackTimer);
    }
    const baseInterval = 1000;
    const interval = baseInterval / this.comparePlaybackSpeed;
    this.comparePlaybackTimer = window.setInterval(() => {
      const referenceTurns = this.getCompareReferenceTurns();
      if (referenceTurns <= 0) {
        this.stopComparePlayback();
        this.compareIsPlaying = false;
        this.updateComparePlayButton();
        return;
      }
      if (this.compareProgressRatio >= 1) {
        this.stopComparePlayback();
        this.compareIsPlaying = false;
        this.updateComparePlayButton();
        return;
      }
      const stepRatio = 1 / referenceTurns;
      const nextRatio = Math.min(this.compareProgressRatio + stepRatio, 1);
      this.renderCompareProgress(nextRatio);
    }, interval);
  }

  private stopComparePlayback() {
    if (this.comparePlaybackTimer) {
      clearInterval(this.comparePlaybackTimer);
      this.comparePlaybackTimer = null;
    }
  }

  private setComparePlaybackSpeed(speed: number) {
    this.comparePlaybackSpeed = speed;
    document.querySelectorAll('.btn-speed-compare').forEach((btn) => {
      const el = btn as HTMLElement;
      el.classList.toggle(
        'active',
        parseInt(el.dataset.speed || '1', 10) === speed
      );
    });
    if (this.compareIsPlaying) {
      this.stopComparePlayback();
      this.startComparePlayback();
    }
  }

  private openMapEditor() {
    const canvas = document.getElementById(
      'map-editor-canvas'
    ) as HTMLCanvasElement;
    if (!this.mapEditor && canvas) {
      this.mapEditor = new MapEditor(canvas, this.network);
    }
    if (this.mapEditor) {
      this.mapEditor.render();
      this.refreshSavedMapList();
    }
    this.showScreen('map-editor-screen');
  }

  private async refreshLobbyMapList() {
    const selectEl = document.getElementById(
      'map-select-create'
    ) as HTMLSelectElement;
    const lobbyMapListEl = document.getElementById('lobby-map-list');
    if (!selectEl && !lobbyMapListEl) return;

    const maps = await fetchMapList(this.network);
    this.cachedMaps = maps;

    if (selectEl) {
      const current = selectEl.value;
      selectEl.innerHTML = '<option value="">🎲 随机地图</option>';
      for (const m of maps) {
        const opt = document.createElement('option');
        opt.value = m.mapId;
        opt.textContent = `${m.name} (${m.spawnCount}出生点, 👍${m.likeCount || 0})`;
        selectEl.appendChild(opt);
      }
      selectEl.value = current;
    }

    this.renderLobbyMapListWithThumbs(maps);
  }

  private renderLobbyMapListWithThumbs(maps: MapListItem[]) {
    const container = document.getElementById('lobby-map-list');
    if (!container) return;

    if (maps.length === 0) {
      container.innerHTML = '<div style="color:var(--text-secondary);padding:8px;">暂无自定义地图</div>';
      return;
    }

    container.innerHTML = maps
      .map((m) => {
        const date = new Date(m.createdAt).toLocaleDateString('zh-CN');
        const thumbData = m.thumbnail ? thumbnailToDataUrl(m.thumbnail) : '';
        return `
          <div class="lobby-map-item" data-map-id="${m.mapId}">
            <canvas class="map-thumbnail" width="64" height="64" data-thumb="${m.thumbnail || ''}"></canvas>
            <div class="map-item-content">
              <div class="map-item-title">${this.escapeHtml(m.name)}</div>
              <div class="map-item-info">${m.spawnCount}出生点 · ${date}</div>
              <div class="map-item-likes">
                <button class="btn-like" data-map-id="${m.mapId}" title="点赞">
                  ${m.isLiked ? '❤️' : '🤍'}
                </button>
                <span class="like-count">${m.likeCount || 0}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('canvas.map-thumbnail').forEach((canvas) => {
      const c = canvas as HTMLCanvasElement;
      const thumbData = c.dataset.thumb;
      if (thumbData) {
        renderThumbnailToCanvas(thumbData, c);
      }
    });

    container.querySelectorAll('.btn-like').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mapId = (btn as HTMLElement).dataset.mapId;
        if (mapId) {
          this.likeMap(mapId);
        }
      });
    });

    container.querySelectorAll('.lobby-map-item').forEach((el) => {
      el.addEventListener('click', () => {
        const mapId = (el as HTMLElement).dataset.mapId;
        const selectEl = document.getElementById('map-select-create') as HTMLSelectElement;
        if (selectEl && mapId) {
          selectEl.value = mapId;
          container.querySelectorAll('.lobby-map-item').forEach(i => i.classList.remove('selected'));
          (el as HTMLElement).classList.add('selected');
        }
      });
    });
  }

  private async refreshSavedMapList() {
    const listEl = document.getElementById('saved-map-list');
    if (!listEl) return;
    listEl.innerHTML = '<div>加载中...</div>';
    const maps = await fetchMapList(this.network);
    this.cachedMaps = maps;

    if (maps.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-secondary);padding:8px;">暂无保存的地图</div>';
      return;
    }

    listEl.innerHTML = maps
      .map((m) => {
        const date = new Date(m.createdAt).toLocaleDateString('zh-CN');
        const thumbData = m.thumbnail ? thumbnailToDataUrl(m.thumbnail) : '';
        return `
          <div class="saved-map-item" data-map-id="${m.mapId}">
            <canvas class="map-thumbnail" width="64" height="64" data-thumb="${m.thumbnail || ''}"></canvas>
            <div class="saved-map-item-main">
              <div class="saved-map-item-title">${this.escapeHtml(m.name)}</div>
              <div class="saved-map-item-info">${m.spawnCount}出生点 · ${date}</div>
              <div class="map-item-likes">
                <button class="btn-like" data-map-id="${m.mapId}" title="点赞">
                  ${m.isLiked ? '❤️' : '🤍'}
                </button>
                <span class="like-count">${m.likeCount || 0}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('canvas.map-thumbnail').forEach((canvas) => {
      const c = canvas as HTMLCanvasElement;
      const thumbData = c.dataset.thumb;
      if (thumbData) {
        renderThumbnailToCanvas(thumbData, c);
      }
    });

    listEl.querySelectorAll('.saved-map-item').forEach((el) => {
      el.addEventListener('click', async () => {
        const mapId = (el as HTMLElement).dataset.mapId;
        if (mapId && !(el as HTMLElement).classList.contains('like-clicked')) {
          await this.loadMapIntoEditor(mapId);
        }
        (el as HTMLElement).classList.remove('like-clicked');
      });
    });

    listEl.querySelectorAll('.btn-like').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mapId = (btn as HTMLElement).dataset.mapId;
        const parent = (btn as HTMLElement).closest('.saved-map-item');
        if (parent) {
          (parent as HTMLElement).classList.add('like-clicked');
        }
        if (mapId) {
          this.likeMap(mapId);
        }
      });
    });
  }

  private async likeMap(mapId: string) {
    const clientId = getOrCreateClientId();
    this.network.send({ type: 'like_map', payload: { mapId, clientId } });
    setTimeout(() => {
      this.refreshLobbyMapList();
      this.refreshSavedMapList();
    }, 100);
  }

  private async loadMapIntoEditor(mapId: string) {
    return new Promise<void>((resolve) => {
      const handler = (payload: any) => {
        this.network.off('map_data', handler);
        if (payload?.map && this.mapEditor) {
          this.mapEditor.loadMap(payload.map as CustomMapData);
          const nameInput = document.getElementById(
            'map-name-input'
          ) as HTMLInputElement;
          if (nameInput) {
            nameInput.value = payload.map.name || '';
          }
        }
        resolve();
      };
      this.network.once('map_data', handler);
      this.network.send({ type: 'get_map', payload: { mapId } });

      setTimeout(() => {
        this.network.off('map_data', handler);
        resolve();
      }, 5000);
    });
  }

  private async validateCurrentMap() {
    if (!this.mapEditor) return;
    const resultEl = document.getElementById('map-validation-result');
    const nameInput = document.getElementById(
      'map-name-input'
    ) as HTMLInputElement;
    const name = nameInput?.value.trim() || '未命名地图';

    if (resultEl) {
      resultEl.className = 'map-validation-result';
      resultEl.textContent = '验证中...';
    }

    const result = await this.mapEditor.validateMap(name);
    if (resultEl) {
      if (!result) {
        resultEl.className = 'map-validation-result error';
        resultEl.textContent = '⚠️ 验证请求超时，请重试';
      } else if (result.valid) {
        resultEl.className = 'map-validation-result success';
        const msgs = ['✅ 地图验证通过！'];
        if (result.warnings?.length) {
          msgs.push(...result.warnings.map((w) => `⚠️ ${w}`));
        }
        resultEl.innerHTML = msgs.join('<br>');
      } else {
        resultEl.className = 'map-validation-result error';
        resultEl.innerHTML = result.errors
          .map((e) => `❌ ${e}`)
          .join('<br>');
      }
    }
  }

  private async saveCurrentMap() {
    if (!this.mapEditor) return;
    const resultEl = document.getElementById('map-validation-result');
    const nameInput = document.getElementById(
      'map-name-input'
    ) as HTMLInputElement;
    const name = nameInput?.value.trim();

    if (!name) {
      if (resultEl) {
        resultEl.className = 'map-validation-result error';
        resultEl.textContent = '❌ 请先输入地图名称';
      }
      return;
    }

    if (resultEl) {
      resultEl.className = 'map-validation-result';
      resultEl.textContent = '保存中...';
    }

    const validateResult = await this.mapEditor.validateMap(name);
    if (!validateResult || !validateResult.valid) {
      if (resultEl) {
        resultEl.className = 'map-validation-result error';
        const errs = validateResult?.errors || ['验证请求失败'];
        resultEl.innerHTML = ['请先修复以下问题：', ...errs.map((e) => `❌ ${e}`)].join('<br>');
      }
      return;
    }

    const saved = await this.mapEditor.saveMap(name);
    if (resultEl) {
      if (saved) {
        resultEl.className = 'map-validation-result success';
        resultEl.innerHTML = `✅ 地图保存成功！<br>地图ID: ${saved.mapId}`;
        this.refreshSavedMapList();
        this.refreshLobbyMapList();
      } else {
        resultEl.className = 'map-validation-result error';
        resultEl.textContent = '❌ 地图保存失败，请重试';
      }
    }
  }

  private setRoomMap(customMapId: string | null) {
    this.network.send({
      type: 'set_room_map',
      payload: { roomId: this.roomId, customMapId: customMapId || undefined },
    });
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const app = new GameController();
  await app.init();
});
