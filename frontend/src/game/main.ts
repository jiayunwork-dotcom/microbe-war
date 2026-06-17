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
} from './types.js';
import { GameWebSocket } from './network.js';
import { DishRenderer, RenderAnimation } from './renderer.js';

const MICROBE_NAMES: Record<MicrobeType, string> = {
  bacteria: '🦠 细菌',
  fungi: '🍄 真菌',
  protozoa: '🦠 原生动物',
  phage: '☠️ 噬菌体',
};

class GameController {
  private network: GameWebSocket;
  private renderer: DishRenderer | null = null;

  private roomId: string = '';
  private myPlayerId: string = '';
  private gameState: GameState | null = null;
  private currentAction: ActionType = 'spread';
  private selectedColonyId: string | null = null;

  private submitted: boolean = false;
  private markerMode: MarkerType | null = null;
  private alliances: Alliance[] = [];
  private pendingAllianceFrom: string | null = null;

  constructor() {
    this.network = new GameWebSocket();
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

    this.setupChatHandlers('waiting-chat-input', 'waiting-chat-send', 'waiting-chat-messages');
    this.setupChatHandlers('game-chat-input', 'game-chat-send', 'game-chat-messages');

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
  }

  private setupChatHandlers(inputId: string, sendBtnId: string, _messagesId: string) {
    const input = document.getElementById(inputId) as HTMLInputElement;
    const sendBtn = document.getElementById(sendBtnId);

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.sendChatFromInput(inputId);
        }
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        this.sendChatFromInput(inputId);
      });
    }
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

    const name = nameEl.value.trim();
    const type = typeEl.value as MicrobeType;
    const roomName = roomNameEl.value.trim();

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
        <button class="btn btn-small room-item-join" data-room-id="${r.id}">快速加入</button>
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
    this.updateGameScreen();
    this.addEventsToLog(this.gameState!.eventLog);
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
  }

  private escapeHtml(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const app = new GameController();
  await app.init();
});
