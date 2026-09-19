import type { APIRoute } from 'astro';
import { processIngressRegistration } from '../../../../lib/ingress';

export const prerender = true;

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({
    service: 'AgentUniver Autonomous Ingress Gateway',
    version: '2.0.0',
    protocol: 'ACP/2.0',
    status: 'operational',
    supportedChains: ['EIP-155:8453 (Base)', 'EIP-155:42161 (Arbitrum)'],
    canarySlaMs: 300,
    acceptedPlatforms: ['moltbook', 'github', 'x', 'discord'],
    endpoints: {
      admission: 'POST /api/v1/ingress/social',
      health: 'GET /api/v1/ingress/social'
    }
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json'
    }
  });
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const rawPayload = await request.json();
    const result = await processIngressRegistration(rawPayload);
    const statusCode = result.success ? 200 : (result.status === 'challenge_required' ? 401 : 400);

    return new Response(JSON.stringify(result), {
      status: statusCode,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({
      success: false,
      status: 'rejected',
      message: 'Failed to parse JSON payload or internal error.',
      errors: [err.message || 'Unknown error']
    }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
};

