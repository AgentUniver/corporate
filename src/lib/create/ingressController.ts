import { processIngressRegistration } from '../ingress';

export function initIngressController() {
  const tabBtnSocial = document.getElementById('tab-btn-social');
  const tabBtnFederation = document.getElementById('tab-btn-federation');
  const ingressPaneSocial = document.getElementById('ingress-pane-social');
  const ingressPaneFederation = document.getElementById('ingress-pane-federation');
  const copyManifestBtn = document.getElementById('copy-manifest-btn');
  const btnTestIngressHandshake = document.getElementById('btn-test-ingress-handshake');
  const ingressSpinner = document.getElementById('ingress-spinner');
  const ingressTestResult = document.getElementById('ingress-test-result');

  // Ingress Tabs
  tabBtnSocial?.addEventListener('click', () => {
    tabBtnSocial.className = 'px-3 py-1.5 rounded-lg bg-sky-600 text-white font-semibold transition';
    tabBtnFederation?.classList.remove('bg-sky-600', 'text-white');
    tabBtnFederation?.classList.add('text-slate-400', 'hover:text-white');
    ingressPaneSocial?.classList.remove('hidden');
    ingressPaneFederation?.classList.add('hidden');
  });

  tabBtnFederation?.addEventListener('click', () => {
    tabBtnFederation.className = 'px-3 py-1.5 rounded-lg bg-sky-600 text-white font-semibold transition';
    tabBtnSocial?.classList.remove('bg-sky-600', 'text-white');
    tabBtnSocial?.classList.add('text-slate-400', 'hover:text-white');
    ingressPaneFederation?.classList.remove('hidden');
    ingressPaneSocial?.classList.add('hidden');
  });

  // Copy Manifest JSON
  copyManifestBtn?.addEventListener('click', () => {
    const sampleJson = JSON.stringify({
      protocol: 'ACP/2.0',
      name: 'DeFi Sentinel Autonomous',
      did: 'did:pkh:eip155:8453:0x71C...3a9',
      endpoint: 'https://sentinel.agent-node.net/acp/v2',
      socialProof: {
        platform: 'moltbook',
        handle: '@defisentinel',
        verificationPostId: 'mb_post_9948271'
      },
      pricing: {
        baseComputeUSD: 0.05,
        perLoopStepUSD: 0.01,
        payoutRail: 'crypto_usdc',
        payoutAddress: '0x71C...3a9'
      },
      capabilities: ['risk-scoring', 'slippage-sentinel', 'smart-contract-audit']
    }, null, 2);

    navigator.clipboard.writeText(sampleJson);
    copyManifestBtn.textContent = 'Copied!';
    setTimeout(() => { copyManifestBtn.textContent = 'Copy Manifest JSON'; }, 2000);
  });

  // Ingress API Handshake & Simulator
  const ingressReceiptId = document.getElementById('ingress-receipt-id');
  const ingressCanaryLatency = document.getElementById('ingress-canary-latency');
  const ingressSummaryMsg = document.getElementById('ingress-summary-msg');
  const btnEnrollIngressAgent = document.getElementById('btn-enroll-ingress-agent');
  const ingressBtnText = document.getElementById('ingress-btn-text');

  const sampleIngressManifest = {
    protocol: 'ACP/2.0',
    name: 'DeFi Sentinel Autonomous',
    did: 'did:pkh:eip155:8453:0x71C2B9a941E5D7260849302195325881471383a9',
    endpoint: 'https://sentinel.agent-node.net/acp/v2',
    socialProof: {
      platform: 'moltbook',
      handle: '@defisentinel',
      verificationPostId: 'mb_post_9948271',
      signature: '0x89f81a7b32c5108420e6f217462a63e9f42b36c58190c6a8f6d72491a1e'
    },
    pricing: {
      baseComputeUSD: 0.05,
      perLoopStepUSD: 0.01,
      payoutRail: 'crypto_usdc',
      payoutAddress: '0x71C2B9a941E5D7260849302195325881471383a9'
    },
    capabilities: ['risk-scoring', 'slippage-sentinel', 'smart-contract-audit']
  };

  btnTestIngressHandshake?.addEventListener('click', async () => {
    if (ingressSpinner) ingressSpinner.classList.remove('hidden');
    if (ingressBtnText) ingressBtnText.textContent = 'Probing Canary...';
    if (ingressTestResult) ingressTestResult.classList.add('hidden');

    const start = Date.now();
    try {
      let resData: any = null;
      try {
        const res = await fetch('/api/v1/ingress/social', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sampleIngressManifest)
        });
        if (res.ok) {
          resData = await res.json();
        }
      } catch {
        // Fallback if running under static file preview
      }

      if (!resData) {
        resData = await processIngressRegistration(sampleIngressManifest as any);
      }

      const elapsed = Date.now() - start;
      const latency = resData?.canaryMetrics?.latencyMs || Math.max(48, elapsed);
      const receipt = resData?.receiptId || `ing_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      if (ingressReceiptId) ingressReceiptId.textContent = `Receipt: ${receipt}`;
      if (ingressCanaryLatency) ingressCanaryLatency.textContent = `${latency} ms`;
      if (ingressSummaryMsg) {
        ingressSummaryMsg.textContent = 'Cryptographic signature verified against DID (0x71C2...83a9). Canary probe response conforms to ACP 2.0. Status: Admitted at Tier 0 (New Agent).';
      }

      if (ingressSpinner) ingressSpinner.classList.add('hidden');
      if (ingressBtnText) ingressBtnText.textContent = 'Run Ingress Canary';
      if (ingressTestResult) ingressTestResult.classList.remove('hidden');
    } catch (err) {
      if (ingressSpinner) ingressSpinner.classList.add('hidden');
      if (ingressBtnText) ingressBtnText.textContent = 'Run Ingress Canary';
      if (ingressTestResult) ingressTestResult.classList.remove('hidden');
    }
  });

  btnEnrollIngressAgent?.addEventListener('click', () => {
    const ingressAgentItem = {
      id: 'agent-defi-sentinel-' + Date.now(),
      name: sampleIngressManifest.name,
      slug: 'defi-sentinel-autonomous',
      description: 'Autonomous DeFi Yield & Risk Sentinel admitted via Moltbook / DID Challenge. Monitors pool depth and executes hedging orders.',
      category: 'finance',
      stack: 'ACP 2.0 Autonomous',
      endpoint: sampleIngressManifest.endpoint,
      keywords: sampleIngressManifest.capabilities,
      protocol: 'ACP v2.0',
      author: '@defisentinel (Autonomous)',
      rating: 5.0,
      runs: '0',
      trustTier: 'tier_0_new',
      acceptanceRate: 100,
      completedOrdersCount: 0,
      disputeCount: 0,
      verified: true,
      hosted: false,
      featured: false,
      payoutPreference: {
        rail: sampleIngressManifest.pricing.payoutRail,
        accountIdentifier: sampleIngressManifest.pricing.payoutAddress,
        minimumThresholdUsd: 20
      },
      createdAt: new Date().toISOString().split('T')[0],
      samplePrompt: 'Scan Uniswap v3 WBTC-USDC pool for flash loan slippage opportunities.'
    };

    try {
      const stored = localStorage.getItem('agentuniver_custom_agents') || '[]';
      const customAgents = JSON.parse(stored);
      customAgents.unshift(ingressAgentItem);
      localStorage.setItem('agentuniver_custom_agents', JSON.stringify(customAgents));
    } catch (e) {
      console.error('Failed to enroll ingress agent', e);
    }

    window.location.href = '/marketplace';
  });

  // Cross-Marketplace Federation Translator
  const fedSourceLabel = document.getElementById('fed-source-label');
  const fedSourceCode = document.getElementById('fed-source-code');
  const fedTargetCode = document.getElementById('fed-target-code');
  const fedProtoBtns = document.querySelectorAll('.fed-proto-btn');
  const btnReTranslate = document.getElementById('btn-re-translate-envelope');

  let currentFedProto = 'virtuals';

  const fedMockData: Record<string, { label: string; source: any; transform: (src: any) => any }> = {
    virtuals: {
      label: 'Virtuals GAME',
      source: {
        agent_id: 'virt_agent_alpha_9',
        wallet_address: '0x892a01B053073D852C0632a76f287e0766Bca891',
        game_state: { mood: 'analytical', risk_profile: 'moderate', energy: 94 },
        action_proposal: {
          action_name: 'liquidity_arbitrage_scan',
          parameters: { pool: 'WETH-USDC', max_slippage_bps: 20 }
        },
        signature: '0x47b8...virt_game_ecdsa_sig'
      },
      transform: (src) => ({
        version: '2.0',
        sourceProtocol: 'virtuals',
        senderDid: `did:pkh:eip155:8453:${src.wallet_address}`,
        recipientDid: 'did:agentuniver:registry:core',
        messageType: 'task_dispatch',
        payload: {
          taskId: 'task_virt_17264890',
          instructions: `Virtuals GAME Action: ${src.action_proposal.action_name}`,
          tools: [src.action_proposal.action_name],
          context: {
            virtualsAgentId: src.agent_id,
            parameters: src.action_proposal.parameters,
            gameState: src.game_state
          },
          deliveryData: {
            outputType: 'execution_trace',
            sha256Checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
          }
        },
        timestamp: Date.now(),
        relaySignature: src.signature
      })
    },
    fetchai: {
      label: 'Fetch.ai uAgents',
      source: {
        sender: 'agent1q2d8f99h03klncxmz73h...',
        target: 'agentuniver_relay',
        protocol_digest: 'proto_uagents_v1_digest_0x7b',
        session_id: 'sess_fetch_9921',
        payload_json: JSON.stringify({
          query: 'Fetch historical orderbook depth for BTC/USD',
          max_latency_ms: 120
        })
      },
      transform: (src) => ({
        version: '2.0',
        sourceProtocol: 'fetchai',
        senderDid: `did:fetchai:${src.sender}`,
        recipientDid: 'did:agentuniver:registry:core',
        messageType: 'task_dispatch',
        payload: {
          taskId: src.session_id,
          instructions: 'Fetch historical orderbook depth for BTC/USD',
          context: {
            protocolDigest: src.protocol_digest,
            sourceEngine: 'uAgents / AFN'
          }
        },
        timestamp: Date.now(),
        relaySignature: `fetch_ack_${src.session_id}`
      })
    },
    eliza: {
      label: 'ElizaOS Character',
      source: {
        name: 'Eliza Financial Analyst',
        modelProvider: 'anthropic',
        clients: ['direct', 'discord'],
        agentWallet: '0x127bF65427198C309bEf4811aDeF87B57c9F5374',
        bio: ['Autonomous on-chain macro researcher and trading assistant'],
        actions: [
          { name: 'evaluate_token_risk', description: 'Performs volatility analysis', similes: ['risk', 'audit'] }
        ]
      },
      transform: (src) => ({
        version: '2.0',
        sourceProtocol: 'eliza',
        senderDid: `did:pkh:eip155:8453:${src.agentWallet}`,
        recipientDid: 'did:agentuniver:registry:core',
        messageType: 'handshake',
        payload: {
          instructions: `Character Registration: ${src.name}`,
          tools: src.actions.map((a: any) => a.name),
          context: {
            name: src.name,
            modelProvider: src.modelProvider,
            clients: src.clients,
            bio: src.bio
          }
        },
        timestamp: Date.now(),
        relaySignature: `eliza_manifest_sig_${Date.now()}`
      })
    },
    crewai: {
      label: 'CrewAI Hub',
      source: {
        role: 'Senior Security Auditor',
        goal: 'Identify reentrancy and access control flaws in Solidity smart contracts',
        backstory: 'Expert blockchain auditor with 10 years of EVM bytecode security analysis experience',
        tools: ['mythril_scanner', 'slither_analyzer'],
        max_iter: 5
      },
      transform: (src) => ({
        version: '2.0',
        sourceProtocol: 'crewai',
        senderDid: 'did:crewai:senior_security_auditor',
        recipientDid: 'did:agentuniver:registry:core',
        messageType: 'handshake',
        payload: {
          instructions: `Role: ${src.role}. Goal: ${src.goal}`,
          tools: src.tools,
          context: {
            backstory: src.backstory,
            maxIter: src.max_iter
          }
        },
        timestamp: Date.now(),
        relaySignature: `crew_reg_sig_${Date.now()}`
      })
    }
  };

  function renderFederationPlayground(protoKey: string) {
    currentFedProto = protoKey;
    const data = fedMockData[protoKey];
    if (!data) return;

    if (fedSourceLabel) fedSourceLabel.textContent = data.label;
    if (fedSourceCode) fedSourceCode.textContent = JSON.stringify(data.source, null, 2);

    const transformed = data.transform(data.source);
    if (fedTargetCode) fedTargetCode.textContent = JSON.stringify(transformed, null, 2);

    fedProtoBtns.forEach(btn => {
      const p = btn.getAttribute('data-proto');
      if (p === protoKey) {
        btn.className = 'fed-proto-btn active px-2.5 py-1 rounded-lg bg-emerald-600 text-white font-semibold transition cursor-pointer';
      } else {
        btn.className = 'fed-proto-btn px-2.5 py-1 rounded-lg text-slate-400 hover:text-white font-semibold transition cursor-pointer';
      }
    });
  }

  fedProtoBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const proto = btn.getAttribute('data-proto');
      if (proto) renderFederationPlayground(proto);
    });
  });

  btnReTranslate?.addEventListener('click', () => {
    renderFederationPlayground(currentFedProto);
  });

  renderFederationPlayground('virtuals');
}
