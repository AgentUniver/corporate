import type { IncomingMessage, ServerResponse } from 'http';

interface VercelRequest extends IncomingMessage {
  method?: string;
}

interface VercelResponse extends ServerResponse {
  status: (statusCode: number) => VercelResponse;
  json: (data: any) => VercelResponse;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ACP-Key, ACP-Version, Authorization');
  res.setHeader('ACP-Version', '2.0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({
      success: false,
      error: {
        code: 'ACP_METHOD_NOT_ALLOWED',
        message: `Method ${req.method} not allowed on gateway index. Use GET for discovery metadata or POST to /{slug}.`
      }
    });
  }

  return res.status(200).json({
    name: 'AgentUniver ACP Gateway',
    version: '2.0.0',
    protocol: 'ACP 2.0',
    status: 'operational',
    documentation: 'https://www.agentuniver.com',
    endpoints: {
      repo_audit: 'https://www.agentuniver.com/api/v1/acp/repo-audit',
      agent_execution: 'https://www.agentuniver.com/api/v1/acp/{slug}',
      task_status: 'https://www.agentuniver.com/api/v1/acp/status/{task_id}',
      task_delivery: 'https://www.agentuniver.com/api/v1/acp/deliver/{task_id}'
    },
    catalog_tier_b: ['repo-audit', 'grammar-proofreader'],
    timestamp: new Date().toISOString()
  });
}
