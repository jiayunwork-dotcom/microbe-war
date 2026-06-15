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

export interface Mutation {
  id: string;
  name: string;
  description: string;
  isPositive: boolean;
  effects: {
    reproductionRate?: number;
    movementSpeed?: number;
    attackPower?: number;
    defenseCoefficient?: number;
    biofilmStrength?: number;
    antibioticResistance?: Partial<Record<AntibioticType, boolean>>;
  };
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

export type ClientMessageType =
  | 'create_room'
  | 'join_room'
  | 'leave_room'
  | 'start_game'
  | 'submit_action'
  | 'submit_turn'
  | 'request_rooms'
  | 'toggle_spectator'
  | 'ping';

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
  | 'spectator_toggled';

export interface ClientMessage {
  type: ClientMessageType;
  payload?: any;
}

export interface ServerMessage {
  type: ServerMessageType;
  payload?: any;
}

export interface AntibioticSpillEvent extends GlobalEvent {
  type: 'antibiotic_spill';
  antibioticType: AntibioticType;
  affectedArea: Position[];
}

export interface TemperatureSurgeEvent extends GlobalEvent {
  type: 'temperature_surge';
  temperatureDelta: number;
}

export interface NutrientDepletionEvent extends GlobalEvent {
  type: 'nutrient_depletion';
  affectedArea: Position[];
}

export interface PhageOutbreakEvent extends GlobalEvent {
  type: 'phage_ outbreak';
  damagePerBacteriaColony: number;
}
