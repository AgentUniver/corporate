export interface AgentItem {
  id: string;
  name: string;
  slug: string;
  subdomain: string;
  description: string;
  category: 
    | "finance"
    | "automation" 
    | "travel" 
    | "personal assistant" 
    | "design" 
    | "data analysis" 
    | "payments" 
    | "healthcare" 
    | "research" 
    | "documentation"
    | "devops"
    | "web3";
  stack: "LangChain" | "LlamaIndex" | "CrewAI" | "AutoGen" | "uAgents / AFN" | "Custom REST / ACP";
  endpoint: string;
  keywords: string[];
  protocol: "ACP 2.0" | "AFN-001" | "AFN-002" | "MCP" | "REST";
  acpAvailable?: boolean;
  author: string;
  authorUrl?: string;
  avatarIcon?: string;
  rating: number;
  runs: string;
  interactions: string;
  hirePrice: number; // USD per task
  verified: boolean;
  hosted: boolean;
  buildable: boolean;
  commercial: boolean;
  featured: boolean;
  createdAt: string;
  samplePrompt?: string;
  // Result-based pricing & AFN Trust Score (GPT-aligned model)
  pricingModel?: "result_based" | "task_based";
  resultMetric?: string;       // e.g., "Qualified Lead", "Verified Record", "Completed Report"
  resultUnitPrice?: number;    // e.g., 0.50 (USD per deliverable unit)
  slaThreshold?: string;       // e.g., "≥85% accuracy guarantee"
  trustScore?: {
    verifiedDeliveries: number; // e.g. 10283
    accuracyRate: number;       // e.g. 86.8 (%)
    repeatHireRate: number;     // e.g. 69 (%)
    totalGmvUsd: number;        // e.g. 182400
  };
  // Upwork-style Progressive Trust Certification Ladder (PRD 4.1)
  trustTier?: 'tier_0_new' | 'tier_1_rising' | 'tier_2_top_rated' | 'tier_3_certified';
  acceptanceRate?: number; // percentage, e.g. 98.5
  completedOrdersCount?: number;
  disputeCount?: number;
}
