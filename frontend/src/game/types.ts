export type MicrobeType = 'bacteria' | 'fungi' | 'protozoa' | 'phage';
export type SpreadMode = 'binary_fission' | 'spore' | 'budding' | 'conjugation';
export type AttackType = 'toxin' | 'lysozyme' | 'phage_injection' | 'nutrient_competition';
export type ActionType = 'spread' | 'attack' | 'evolve';
export type AntibioticType = 'penicillin' | 'streptomycin' | 'tetracycline';
export type GlobalEventType =
  | 'antibiotic_spill'
  | 'temperature_surge'
  | 'nutrient_depletion'
  | 'phage_ outbreak';

export type TerrainType = 'normal' | 'high_nutrient' | 'barren' | 'toxin' | 'barrier';
export type SymmetryMode = 'none' | 'horizontal' | 'vertical' | 'four_way';
export type BrushSize = 1 | 3 | 5;
export type EditMode = 'terrain' | 'spawn';

export interface CustomMapData {
  mapId: string;
  name: string;
  createdAt: number;
  gridSize: number;
  terrain: TerrainType[][];
  spawnPoints: Position[];
  thumbnail?: string;
  likeCount?: number;
  likedBy?: string[];
}

export interface MapListItem {
  mapId: string;
  name: string;
  createdAt: number;
  spawnCount: number;
  thumbnail?: string;
  likeCount?: number;
  likedBy?: string[];
  isLiked?: boolean;
}

export type MapPresetType = 'arena' | 'maze' | 'toxic_swamp';

export type ClientMessageType =
  | 'create_room'
  | 'join_room'
  | 'leave_room'
  | 'start_game'
  | 'submit_action'
  | 'submit_turn'
  | 'request_rooms'
  | 'toggle_spectator'
  | 'ping'
  | 'send_chat'
  | 'place_marker'
  | 'alliance_request'
  | 'alliance_respond'
  | 'request_replay'
  | 'request_replay_list'
  | 'list_maps'
  | 'validate_map'
  | 'save_map'
  | 'get_map'
  | 'set_room_map'
  | 'like_map';

export type ServerMessageType =
  | 'room_created'
  | 'room_joined'
  | 'room_left'
  | 'room_list'
  | 'player_joined'
  | 'player_left'
  | 'game_started'
  | 'game_state'
  | 'turn_ended'
  | 'turn_result'
  | 'action_result'
  | 'game_ended'
  | 'error'
  | 'pong'
  | 'spectator_toggled'
  | 'chat_message'
  | 'marker_placed'
  | 'marker_removed'
  | 'alliance_request_received'
  | 'alliance_formed'
  | 'alliance_broken'
  | 'alliances_update'
  | 'replay_data'
  | 'replay_list'
  | 'game_ended_with_stats'
  | 'map_saved'
  | 'map_list'
  | 'map_data'
  | 'map_validation'
  | 'room_updated'
  | 'map_liked';

export interface MapValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

export interface Position {
  x: number;
  y: number;
}

export interface ColoniesProperties {
  reproductionRate: number;
  movementSpeed: number;
  attackPower: number;
  defenseCoefficient: number;
  biofilmStrength: number;
  spreadMode: SpreadMode;
  attackType: AttackType;
  antibioticResistance: Record<AntibioticType, boolean>;
  mutations: string[];
}

export interface Colony {
  id: string;
  playerId: string;
  position: Position;
  microbeType: MicrobeType;
  biomass: number;
  maxBiomass: number;
  biofilmLayers: number;
  properties: ColoniesProperties;
  phageInjectionTurnsLeft: number | null;
  timesAttackedRecently: number;
}

export interface CellEnvironment {
  nutrient: number;
  maxNutrient: number;
  temperature: number;
  pH: number;
  antibiotics: Partial<Record<AntibioticType, number>>;
  terrain: TerrainType;
}

export interface Cell {
  position: Position;
  colony: Colony | null;
  environment: CellEnvironment;
}

export interface Player {
  id: string;
  name: string;
  microbeType: MicrobeType;
  color: string;
  isAlive: boolean;
  isSpectator: boolean;
  isHost: boolean;
  hasSubmitted: boolean;
  totalArea: number;
  weightedArea: number;
}

export interface PlayerAction {
  playerId: string;
  actionType: ActionType;
  colonyId?: string;
  targetPosition?: Position;
}

export interface GlobalEvent {
  type: GlobalEventType;
  description: string;
  affectedArea?: Position[];
  turn: number;
}

export interface EventLogEntry {
  turn: number;
  message: string;
  type: 'info' | 'attack' | 'mutation' | 'event' | 'elimination' | 'victory';
  playerId?: string;
}

export interface GameState {
  id: string;
  status: 'waiting' | 'playing' | 'finished';
  turn: number;
  maxTurns: number;
  gridSize: number;
  grid: Cell[][];
  players: Player[];
  colonies: Colony[];
  globalEvents: GlobalEvent[];
  eventLog: EventLogEntry[];
  winnerId: string | null;
  rankings: Array<{
    playerId: string;
    area: number;
    weightedArea: number;
  }>;
}

export interface RoomInfo {
  id: string;
  name: string;
  status: 'waiting' | 'playing' | 'finished';
  playerCount: number;
  maxPlayers: number;
  hostName: string;
  turn?: number;
  customMapId: string | null;
  customMapName?: string;
}

export type MarkerType = 'danger' | 'target' | 'defense';

export interface TacticalMarker {
  id: string;
  playerId: string;
  type: MarkerType;
  position: Position;
  placedTurn: number;
  color: string;
}

export interface Alliance {
  playerId1: string;
  playerId2: string;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  playerColor: string;
  content: string;
  timestamp: number;
  isSystem: boolean;
}


export interface ClientMessage {
  type: ClientMessageType;
  payload?: any;
}

export interface ServerMessage {
  type: ServerMessageType;
  payload?: any;
}

export interface KillEvent {
  turn: number;
  attackerPlayerId: string;
  victimPlayerId: string;
  colonyId: string;
}

export interface TurnSnapshot {
  turn: number;
  gridSnapshot: Cell[][];
  colonies: Colony[];
  playerAreas: Record<string, number>;
}

export interface TurnAction {
  turn: number;
  playerId: string;
  actionType: ActionType;
  colonyId?: string;
  targetPosition?: Position;
  targetPlayerId?: string;
}

export interface AllianceEvent {
  turn: number;
  type: 'formed' | 'broken';
  playerId1: string;
  playerId2: string;
  betrayerId?: string;
}

export interface PlayerStats {
  playerId: string;
  playerName: string;
  playerColor: string;
  microbeType: MicrobeType;
  totalSpreadCount: number;
  totalAttackCount: number;
  totalEvolveCount: number;
  kills: number;
  deaths: number;
  maxAreaPeak: number;
  survivalTurns: number;
  allianceCount: number;
  betrayalCount: number;
  finalRank: number;
  finalArea: number;
  finalWeightedArea: number;
}

export interface GameStats {
  totalTurns: number;
  mostViolentTurn: {
    turn: number;
    killCount: number;
  };
  mvp: {
    playerId: string;
    playerName: string;
    score: number;
  } | null;
  playerStats: PlayerStats[];
  areaHistory: Array<{
    turn: number;
    areas: Record<string, number>;
  }>;
}

export type HighlightType = 'multi_kill' | 'territory_surge' | 'betrayal';

export interface Highlight {
  turn: number;
  type: HighlightType;
  description: string;
  details?: {
    killCount?: number;
    playerId?: string;
    playerName?: string;
    territoryGrowth?: number;
    betrayerId?: string;
    betrayerName?: string;
    victimId?: string;
    victimName?: string;
  };
}

export interface ReplayData {
  replayId: string;
  roomId: string;
  roomName: string;
  gameId: string;
  startTime: number;
  endTime: number;
  maxTurns: number;
  gridSize: number;
  players: Player[];
  initialState: {
    grid: Cell[][];
    colonies: Colony[];
    turn: number;
  };
  turnSnapshots: TurnSnapshot[];
  turnActions: TurnAction[];
  turnEvents: EventLogEntry[][];
  allianceEvents: AllianceEvent[];
  chatMessages: ChatMessage[];
  markers: TacticalMarker[][];
  finalRankings: Array<{
    playerId: string;
    area: number;
    weightedArea: number;
  }>;
  winnerId: string | null;
  stats: GameStats;
  highlights: Highlight[];
}

export interface ReplayListItem {
  replayId: string;
  roomId: string;
  roomName: string;
  startTime: number;
  endTime: number;
  totalTurns: number;
  playerCount: number;
  winnerName: string | null;
  winnerColor: string | null;
}
