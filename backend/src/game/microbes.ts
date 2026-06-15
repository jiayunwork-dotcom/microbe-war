import {
  MicrobeType, ColoniesProperties, SpreadMode, AttackType, AntibioticType
} from './types';
import { v4 as uuidv4 } from 'uuid';

export interface MicrobeTemplate {
  type: MicrobeType;
  name: string;
  description: string;
  baseProperties: ColoniesProperties;
  optimalPh: [number, number];
  optimalTemperature: [number, number];
}

export const MICROBE_TEMPLATES: Record<MicrobeType, MicrobeTemplate> = {
  bacteria: {
    type: 'bacteria',
    name: '细菌',
    description: '繁殖最快但防御弱，二分裂快速扩展领地',
    baseProperties: {
      reproductionRate: 1.5,
      movementSpeed: 2,
      attackPower: 8,
      defenseCoefficient: 0.7,
      biofilmStrength: 1,
      spreadMode: 'binary_fission',
      attackType: 'toxin',
      antibioticResistance: {
        penicillin: false,
        streptomycin: false,
        tetracycline: false,
      },
      mutations: [],
    },
    optimalPh: [6.5, 7.5],
    optimalTemperature: [30, 40],
  },
  fungi: {
    type: 'fungi',
    name: '真菌',
    description: '移动慢但能形成厚实的生物膜防御带',
    baseProperties: {
      reproductionRate: 0.8,
      movementSpeed: 1,
      attackPower: 10,
      defenseCoefficient: 1.5,
      biofilmStrength: 3,
      spreadMode: 'budding',
      attackType: 'lysozyme',
      antibioticResistance: {
        penicillin: true,
        streptomycin: false,
        tetracycline: false,
      },
      mutations: [],
    },
    optimalPh: [5.0, 7.0],
    optimalTemperature: [20, 35],
  },
  protozoa: {
    type: 'protozoa',
    name: '原生动物',
    description: '体型大可以吞噬小型菌落但繁殖慢',
    baseProperties: {
      reproductionRate: 0.6,
      movementSpeed: 3,
      attackPower: 15,
      defenseCoefficient: 1.0,
      biofilmStrength: 2,
      spreadMode: 'spore',
      attackType: 'lysozyme',
      antibioticResistance: {
        penicillin: true,
        streptomycin: true,
        tetracycline: false,
      },
      mutations: [],
    },
    optimalPh: [6.0, 8.0],
    optimalTemperature: [25, 37],
  },
  phage: {
    type: 'phage',
    name: '噬菌体',
    description: '不占面积但能注入其他菌落使其死亡',
    baseProperties: {
      reproductionRate: 1.2,
      movementSpeed: 4,
      attackPower: 0,
      defenseCoefficient: 0.5,
      biofilmStrength: 0,
      spreadMode: 'spore',
      attackType: 'phage_injection',
      antibioticResistance: {
        penicillin: true,
        streptomycin: true,
        tetracycline: true,
      },
      mutations: [],
    },
    optimalPh: [6.5, 8.0],
    optimalTemperature: [25, 42],
  },
};

export const PLAYER_COLORS = [
  '#FF6B6B',
  '#4ECDC4',
  '#45B7D1',
  '#96CEB4',
  '#FFEAA7',
  '#DDA0DD',
];

export function createColonyProperties(
  microbeType: MicrobeType
): ColoniesProperties {
  const template = MICROBE_TEMPLATES[microbeType];
  return JSON.parse(JSON.stringify(template.baseProperties));
}

export function generateColonyId(): string {
  return 'col_' + uuidv4().slice(0, 8);
}

export function getSpreadRange(mode: SpreadMode): {
  min: number;
  max: number;
} {
  switch (mode) {
    case 'binary_fission':
      return { min: 1, max: 1 };
    case 'spore':
      return { min: 3, max: 5 };
    case 'budding':
      return { min: 1, max: 2 };
    case 'conjugation':
      return { min: 1, max: 1 };
  }
}

export function calculateEnvironmentFitness(
  microbeType: MicrobeType,
  temperature: number,
  pH: number
): number {
  const template = MICROBE_TEMPLATES[microbeType];
  const [tempMin, tempMax] = template.optimalTemperature;
  const [phMin, phMax] = template.optimalPh;

  let tempScore = 1;
  if (temperature < tempMin) {
    tempScore = 0.5 + 0.5 * (temperature / tempMin);
  } else if (temperature > tempMax) {
    tempScore = Math.max(0.3, 1 - (temperature - tempMax) / 20);
  }

  let phScore = 1;
  if (pH < phMin) {
    phScore = 0.5 + 0.5 * (pH / phMin);
  } else if (pH > phMax) {
    phScore = Math.max(0.3, 1 - (pH - phMax) / 3);
  }

  return tempScore * phScore;
}
