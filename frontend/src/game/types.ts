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
  | 'alliance_respond';

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
  | 'alliances_update';

export interface ClientMessage {
  type: ClientMessageType;
  payload?: any;
}

export interface ServerMessage {
  type: ServerMessageType;
  payload?: any;
}
