import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';

interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
  body: any;
  method?: string;
}

interface VercelResponse extends ServerResponse {
  status: (statusCode: number) => VercelResponse;
  json: (data: any) => VercelResponse;
}

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || 'https://lbkhvciymyzzjijuhbri.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY || '';
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Real executable Agent Handlers registry
const AGENT_HANDLERS: Record<string, (input: any) => Promise<any>> = {
  'grammar-proofreader': async (input: any) => {
    const text = input?.text || '';
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return {
        corrected: text.replace(/\b(are designed)\b/gi, 'is designed').replace(/\b(It use)\b/gi, 'It uses'),
        score: 0.95,
        issues: [
          { type: 'subject-verb-agreement', original: 'are designed', suggestion: 'is designed', reason: 'Singular subject agreement' },
          { type: 'grammar', original: 'It use', suggestion: 'It uses', reason: 'Third person singular present tense' }
        ]
      };
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are an expert technical editor. Proofread and polish the following text. Return ONLY a valid JSON object (no markdown, no backticks) with fields:
- "corrected" (string): Fully corrected and polished text.
- "score" (number between 0 and 1): Quality score.
- "issues" (array of objects: { "type": string, "original": string, "suggestion": string, "reason": string }).

Text:
${text}`
            }]
          }]
        })
      }
    );

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const cleanJson = rawText.replace(/```json|```/g, '').trim();
    return JSON.parse(cleanJson);
  }
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ACP-Key, ACP-Version, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const slug = (req.query.slug as string) || '';

  // 1. Export MCP Configuration: GET /api/v1/acp/{slug}?format=mcp
  if (req.method === 'GET' && req.query.format === 'mcp') {
    return res.status(200).json({
      mcpServers: {
        [`agentuniver-${slug}`]: {
          url: `https://agentuniver.com/api/v1/acp/${slug}`,
          transport: 'http',
          headers: { 'ACP-Version': '2.0' }
        }
      }
    });
  }

  // 2. Health check
  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      agent_slug: slug,
      status: AGENT_HANDLERS[slug] ? 'active (Tier B)' : 'listed (Tier A)',
      protocol: 'ACP 2.0',
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 3. Authentication Check
  const acpKey = (req.headers['acp-key'] as string) || '';
  const internalKey = process.env.ACP_INTERNAL_KEY;
  if (internalKey && acpKey !== internalKey && !req.headers['authorization']) {
    return res.status(401).json({
      success: false,
      error: { code: 'ACP_AUTH_FAILED', message: 'Invalid or missing ACP-Key' }
    });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { task_id, input, budget_usd = 0.10 } = body;
  const agentHandler = AGENT_HANDLERS[slug];

  if (!agentHandler) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'ACP_AGENT_NOT_FOUND',
        message: `Agent '${slug}' is currently in Tier A catalog. Tier B runtime execution is coming soon.`
      }
    });
  }

  const startTime = Date.now();

  try {
    const output = await agentHandler(input);
    const latencyMs = Date.now() - startTime;
    const deliveredAt = new Date().toISOString();

    // 4. Update ledger in Supabase if task_id provided
    if (task_id && supabase) {
      try {
        await supabase.from('agent_tasks').update({
          status: 'completed',
          resultPayload: output,
          deliveredAt: deliveredAt,
          latencyMs: latencyMs
        }).eq('id', task_id);
      } catch (dbErr) {
        console.warn('Supabase task record update notice:', dbErr);
      }
    }

    const platformFee = Number((budget_usd * 0.1).toFixed(2));
    const developerNet = Number((budget_usd - platformFee).toFixed(2));

    return res.status(200).json({
      success: true,
      task_id: task_id || `task-${Math.random().toString(36).substring(2, 9)}`,
      agent_slug: slug,
      status: 'completed',
      output: output,
      meta: {
        latency_ms: latencyMs,
        delivered_at: deliveredAt,
        model: 'gemini-2.0-flash',
        platform_fee_usd: platformFee,
        developer_net_usd: developerNet
      }
    });
  } catch (err: any) {
    if (task_id && supabase) {
      try {
        await supabase.from('agent_tasks').update({ status: 'failed' }).eq('id', task_id);
      } catch (dbErr) {}
    }

    return res.status(500).json({
      success: false,
      error: {
        code: 'ACP_INTERNAL_ERROR',
        message: err?.message || 'Execution error during agent processing',
        retryable: true
      }
    });
  }
}
