import {
  Mutation, AntibioticType, Colony
} from './types';
import { v4 as uuidv4 } from 'uuid';

export const MUTATION_POOL: Mutation[] = [
  {
    id: 'mut_penicillin_resist',
    name: '青霉素抗性',
    description: '获得青霉素抗性',
    isPositive: true,
    effects: {
      antibioticResistance: { penicillin: true },
    },
  },
  {
    id: 'mut_streptomycin_resist',
    name: '链霉素抗性',
    description: '获得链霉素抗性',
    isPositive: true,
    effects: {
      antibioticResistance: { streptomycin: true },
    },
  },
  {
    id: 'mut_tetracycline_resist',
    name: '四环素抗性',
    description: '获得四环素抗性',
    isPositive: true,
    effects: {
      antibioticResistance: { tetracycline: true },
    },
  },
  {
    id: 'mut_attack_boost',
    name: '毒素强化',
    description: '毒素攻击力 +20%',
    isPositive: true,
    effects: {
      attackPower: 1.2,
    },
  },
  {
    id: 'mut_biofilm_boost',
    name: '生物膜强化',
    description: '生物膜强度 +1',
    isPositive: true,
    effects: {
      biofilmStrength: 1,
    },
  },
  {
    id: 'mut_movement_boost',
    name: '快速移动',
    description: '移动速度 +50%',
    isPositive: true,
    effects: {
      movementSpeed: 1.5,
    },
  },
  {
    id: 'mut_reproduction_boost',
    name: '快速繁殖',
    description: '繁殖速率 +30%',
    isPositive: true,
    effects: {
      reproductionRate: 1.3,
    },
  },
  {
    id: 'mut_defense_boost',
    name: '防御强化',
    description: '防御系数 +20%',
    isPositive: true,
    effects: {
      defenseCoefficient: 1.2,
    },
  },
  {
    id: 'mut_slow_reproduction',
    name: '繁殖迟缓',
    description: '繁殖速率 -20%',
    isPositive: false,
    effects: {
      reproductionRate: 0.8,
    },
  },
  {
    id: 'mut_weak_defense',
    name: '脆弱防御',
    description: '防御系数 -15%',
    isPositive: false,
    effects: {
      defenseCoefficient: 0.85,
    },
  },
  {
    id: 'mut_slow_movement',
    name: '行动迟缓',
    description: '移动速度 -25%',
    isPositive: false,
    effects: {
      movementSpeed: 0.75,
    },
  },
];

export const BASE_MUTATION_PROBABILITY = 0.03;
export const ANTIBIOTIC_MUTATION_MULTIPLIER = 2;
export const ATTACK_MUTATION_MULTIPLIER = 1.5;

export function getMutationId(): string {
  return 'mut_' + uuidv4().slice(0, 6);
}

export function calculateMutationProbability(
  colony: Colony,
  inAntibioticZone: boolean,
  timesAttacked: number
): number {
  let prob = BASE_MUTATION_PROBABILITY;

  if (inAntibioticZone) {
    prob *= ANTIBIOTIC_MUTATION_MULTIPLIER;
  }

  if (timesAttacked >= 3) {
    prob *= ATTACK_MUTATION_MULTIPLIER;
  }

  return Math.min(prob, 0.2);
}

export function applyMutation(colony: Colony, mutation: Mutation) {
  colony.properties.mutations.push(mutation.id);

  const effects = mutation.effects;

  if (effects.reproductionRate !== undefined) {
    colony.properties.reproductionRate *= effects.reproductionRate;
  }

  if (effects.movementSpeed !== undefined) {
    colony.properties.movementSpeed *= effects.movementSpeed;
  }

  if (effects.attackPower !== undefined) {
    colony.properties.attackPower *= effects.attackPower;
  }

  if (effects.defenseCoefficient !== undefined) {
    colony.properties.defenseCoefficient *= effects.defenseCoefficient;
  }

  if (effects.biofilmStrength !== undefined) {
    colony.properties.biofilmStrength += effects.biofilmStrength;
  }

  if (effects.antibioticResistance) {
    for (const [
      abType,
      value,
    ] of Object.entries(
      effects.antibioticResistance
    ) as [AntibioticType, boolean][]) {
      colony.properties.antibioticResistance[abType] = value;
    }
  }
}

export function getRandomMutation(colony: Colony): Mutation | null {
  const availableMutations = MUTATION_POOL.filter(
    (m) => !colony.properties.mutations.includes(m.id)
  );

  if (availableMutations.length === 0) return null;

  const weightedPool: Mutation[] = [];
  for (const mutation of availableMutations) {
    const weight = mutation.isPositive ? 1 : 0.5;
    for (let i = 0; i < Math.ceil(weight * 10); i++) {
      weightedPool.push(mutation);
    }
  }

  if (weightedPool.length === 0) return null;

  return weightedPool[Math.floor(Math.random() * weightedPool.length)];
}
