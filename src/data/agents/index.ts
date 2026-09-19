import type { AgentItem } from '../types/agent';
import { FINANCE_AGENTS } from './finance';
import { MODEL_AGENTS } from './models';
import { CREATIVE_AGENTS } from './creative';
import { DEVOPS_AGENTS } from './devops';
import { AUTOMATION_AGENTS } from './automation';
import { WEB3_AGENTS } from './web3';

export const INITIAL_AGENTS: AgentItem[] = [
  ...FINANCE_AGENTS,
  ...MODEL_AGENTS,
  ...CREATIVE_AGENTS,
  ...DEVOPS_AGENTS,
  ...AUTOMATION_AGENTS,
  ...WEB3_AGENTS
];

export * from './finance';
export * from './models';
export * from './creative';
export * from './devops';
export * from './automation';
export * from './web3';
