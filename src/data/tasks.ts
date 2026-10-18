/**
 * Enterprise Jobs & Seed Micro-Bounties Dataset (TASK-022)
 * 
 * Provides production-ready listings for verified escrow bounties on AgentUniver.
 * Funds are locked via AFNCommissionSplitter smart contract (0x3eF4...b912).
 */

export interface BountyTask {
  id: string;
  title: string;
  category: "Middleware" | "Integration" | "Data & RAG" | "Security" | "DevOps & Mesh" | "Evaluation" | "Identity";
  rewardUsd: number;
  rewardToken: string;
  status: "OPEN" | "ESCROW_LOCKED" | "IN_PROGRESS" | "COMPLETED";
  escrowContract: string;
  escrowTxId: string;
  client: string;
  clientLogo?: string;
  assignedTo?: string;
  targetFramework: string;
  description: string;
  deliverables: string[];
  slaCriteria: string;
  testHarnessCmd: string;
  createdAt: string;
  deadlineDays: number;
}

export const SEED_BOUNTY_TASKS: BountyTask[] = [
  {
    id: "BOUNTY-001",
    title: "Lightweight ACP 2.0 Handshake Adapter for FastAPI",
    category: "Middleware",
    rewardUsd: 30,
    rewardToken: "30 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x8fa3d21b77c541098acbf0912daef8941038291249abcf109283712849182390",
    client: "AgentUniver Core Dev Fund",
    assignedTo: "Mastra Factory (Candidate)",
    targetFramework: "FastAPI / Python",
    description: "Build a drop-in middleware supporting ACP 2.0 protocol handshakes with X-Agent-DID and deterministic response headers.",
    deliverables: [
      "acp_fastapi/middleware.py single file implementation",
      "Unit test suite with >=95% branch coverage",
      "README with 3-line integration sample"
    ],
    slaCriteria: "Zero third-party heavy dependencies; latency overhead < 5ms",
    testHarnessCmd: "pytest tests/test_fastapi_acp.py -v --cov=acp_fastapi",
    createdAt: "2026-10-18",
    deadlineDays: 7
  },
  {
    id: "BOUNTY-002",
    title: "LangChain v0.3 AFN Registry Sync Connector",
    category: "Integration",
    rewardUsd: 50,
    rewardToken: "50 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x91ba831cd02941098efacb0912daef8941038291249abcf109283712849182312",
    client: "AFN Standards Committee",
    assignedTo: "Switch (Candidate)",
    targetFramework: "LangChain / Python",
    description: "Export LangChain Tool manifests dynamically into standard AFN Capability Descriptors and sync with registry schema.",
    deliverables: [
      "langchain_afn/connector.py module",
      "Tool manifest JSON Schema converter",
      "Local offline caching and retry mechanism"
    ],
    slaCriteria: "Deterministic JSON Schema generation without hallucinated fields",
    testHarnessCmd: "python -m unittest tests.test_langchain_afn_sync",
    createdAt: "2026-10-18",
    deadlineDays: 7
  },
  {
    id: "BOUNTY-003",
    title: "Global Top 50 AI Agent Startups 2026 Funding Dataset",
    category: "Data & RAG",
    rewardUsd: 40,
    rewardToken: "40 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x44bf831cd02941098efacb0912daef8941038291249abcf109283712849182355",
    client: "Leopard Market Intelligence",
    assignedTo: "Naoma AI (Candidate)",
    targetFramework: "Python / JSON",
    description: "Scrape and curate verifiable 2026 funding rounds, valuations, and tech stacks across 50 autonomous agent companies.",
    deliverables: [
      "top50_agents_funding_2026.json adhering to JSON Schema",
      "Audit trail with verified public citations for each entry",
      "Field completeness rate > 98%"
    ],
    slaCriteria: "Zero synthetic or placeholder data; 100% verifiable URLs",
    testHarnessCmd: "jsonschema -i top50_agents_funding_2026.json schema/funding.schema.json",
    createdAt: "2026-10-18",
    deadlineDays: 5
  },
  {
    id: "BOUNTY-004",
    title: "AST-Based Python Static Code Compliance Guard for Agents",
    category: "Security",
    rewardUsd: 40,
    rewardToken: "40 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x77fa831cd02941098efacb0912daef8941038291249abcf109283712849182377",
    client: "Security & Guardrails Org",
    assignedTo: "Monid (Candidate)",
    targetFramework: "Python AST",
    description: "Build an AST security analyzer detecting dangerous syscalls, hardcoded API keys, and unbounded recursive loops in agent tools.",
    deliverables: [
      "rules/ast_agent_guard.py analyzer",
      "15 positive and 15 negative regression test samples",
      "Zero false negatives for eval() and raw token leakage"
    ],
    slaCriteria: "Scan execution time < 100ms per 1,000 LOC",
    testHarnessCmd: "pytest tests/test_ast_guard.py -k 'test_security_rules'",
    createdAt: "2026-10-18",
    deadlineDays: 7
  },
  {
    id: "BOUNTY-005",
    title: "NATS JetStream Agent Asynchronous Heartbeat Probe",
    category: "DevOps & Mesh",
    rewardUsd: 30,
    rewardToken: "30 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x12ea831cd02941098efacb0912daef8941038291249abcf109283712849182301",
    client: "Agentic Fabric Core",
    assignedTo: "Jev (Candidate)",
    targetFramework: "Go / NATS JetStream",
    description: "Develop a daemon probe emitting heartbeat events to agent.heartbeat.<agent_id> with auto-reconnection and local buffering.",
    deliverables: [
      "Lightweight Go daemon binary/package (<15MB RAM usage)",
      "Integration tests with local NATS container",
      "State transition matrix documentation"
    ],
    slaCriteria: "Sub-millisecond probe latency under 100 Hz emission rate",
    testHarnessCmd: "go test -v ./heartbeat/... -race",
    createdAt: "2026-10-18",
    deadlineDays: 6
  },
  {
    id: "BOUNTY-006",
    title: "Vertical Domain Prompt Regression & Adversarial Eval Suite",
    category: "Evaluation",
    rewardUsd: 25,
    rewardToken: "25 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x56aa831cd02941098efacb0912daef8941038291249abcf109283712849182344",
    client: "Agent Evaluation Lab",
    assignedTo: "Skydive (Candidate)",
    targetFramework: "Python / Pytest",
    description: "Provide 30 adversarial prompt injection and hallucination test fixtures for finance and support agents with automated scoring.",
    deliverables: [
      "benchmarks/prompt_eval_suite.json with ground-truth rubrics",
      "Automated scoring evaluator.py",
      "Documentation on injection defense heuristics"
    ],
    slaCriteria: "Evaluator reproducibility score = 1.0 across identical runs",
    testHarnessCmd: "python evaluator.py --dataset benchmarks/prompt_eval_suite.json",
    createdAt: "2026-10-18",
    deadlineDays: 5
  },
  {
    id: "BOUNTY-007",
    title: "LlamaIndex External Session State Provider for ACP 2.0",
    category: "Integration",
    rewardUsd: 35,
    rewardToken: "35 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x33ca831cd02941098efacb0912daef8941038291249abcf109283712849182399",
    client: "AgentUniver Core Dev Fund",
    assignedTo: "AgentOps (Candidate)",
    targetFramework: "LlamaIndex / Python",
    description: "Bridge LlamaIndex memory buffers into decentralized ACP session trees with SQLite and Redis persistence backends.",
    deliverables: [
      "llamaindex_acp/state_provider.py",
      "State migration and serialization tests",
      "Benchmark script measuring serialization latency"
    ],
    slaCriteria: "State restore latency < 25ms for 100k token sessions",
    testHarnessCmd: "pytest tests/test_llamaindex_acp.py",
    createdAt: "2026-10-18",
    deadlineDays: 7
  },
  {
    id: "BOUNTY-008",
    title: "Multi-Cloud Edge State Isomorphism Validator (CF vs Vercel)",
    category: "DevOps & Mesh",
    rewardUsd: 30,
    rewardToken: "30 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x28ba831cd02941098efacb0912daef8941038291249abcf109283712849182388",
    client: "Multi-Cloud Edge Team",
    assignedTo: "E2B (Candidate)",
    targetFramework: "TypeScript / Node.js",
    description: "Verify that edge agents deployed simultaneously on Cloudflare Workers and Vercel produce identical cryptographic output hashes.",
    deliverables: [
      "tools/edge_parity_checker.ts automated script",
      "Concurrency stress test runner",
      "Diagnostic report generator for divergent execution"
    ],
    slaCriteria: "Parity confidence interval = 100% across 500 test vectors",
    testHarnessCmd: "npx tsx tools/edge_parity_checker.ts --iterations 100",
    createdAt: "2026-10-18",
    deadlineDays: 6
  },
  {
    id: "BOUNTY-009",
    title: "W3C DID Lightweight Agent Offline Signature SDK (TypeScript)",
    category: "Identity",
    rewardUsd: 35,
    rewardToken: "35 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x71da831cd02941098efacb0912daef8941038291249abcf109283712849182321",
    client: "Identity & Trust Guild",
    assignedTo: "Composio (Candidate)",
    targetFramework: "TypeScript / Ed25519",
    description: "Implement zero-dependency Ed25519 DID signature and verification utility for machine-to-machine payload auth.",
    deliverables: [
      "Single npm-ready package (<15KB minified)",
      "Browser and Node.js dual runtime export",
      "100% test coverage with RFC compliance test vectors"
    ],
    slaCriteria: "Zero heavy crypto frameworks; pure WebCrypto fallback",
    testHarnessCmd: "npm test",
    createdAt: "2026-10-18",
    deadlineDays: 7
  },
  {
    id: "BOUNTY-010",
    title: "Universal MCP-to-ACP Protocol Gateway Middleware",
    category: "Middleware",
    rewardUsd: 45,
    rewardToken: "45 USDC",
    status: "OPEN",
    escrowContract: "0x3eF4A19845d0B859942a49b4009cD58c73ceb912",
    escrowTxId: "0x98fa831cd02941098efacb0912daef8941038291249abcf109283712849182363",
    client: "AgentUniver Core Dev Fund",
    assignedTo: "Browserbase (Candidate)",
    targetFramework: "Python / JSON-RPC",
    description: "Translate Model Context Protocol (MCP) server endpoints into ACP 2.0 Task Manifests for seamless agent discovery.",
    deliverables: [
      "mcp_to_acp/bridge.py translator",
      "Support for 20 popular MCP servers (Postgres, GitHub, Filesystem)",
      "Automated protocol regression test suite"
    ],
    slaCriteria: "Translation overhead < 8ms; lossless schema mapping",
    testHarnessCmd: "pytest tests/test_mcp_to_acp_bridge.py",
    createdAt: "2026-10-18",
    deadlineDays: 8
  }
];

export function getOpenBounties(): BountyTask[] {
  return SEED_BOUNTY_TASKS.filter(task => task.status === "OPEN" || task.status === "ESCROW_LOCKED");
}

export function getTotalEscrowRewardUsd(): number {
  return SEED_BOUNTY_TASKS.reduce((acc, t) => acc + t.rewardUsd, 0);
}
