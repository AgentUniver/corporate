export function initGenerateController() {
  const promptInput = document.getElementById('generate-prompt-input') as HTMLTextAreaElement | null;
  const templateButtons = document.querySelectorAll('.gen-template-btn');
  const runGenBtn = document.getElementById('btn-run-generate');
  const previewBox = document.getElementById('gen-preview-box');
  const genNameEl = document.getElementById('gen-agent-name');
  const genDescEl = document.getElementById('gen-agent-desc');
  const genKeywordsEl = document.getElementById('gen-agent-keywords');
  const publishGenBtn = document.getElementById('btn-publish-gen-agent');

  let generatedAgentData: any = null;

  templateButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tmpl = btn.getAttribute('data-template');
      if (tmpl && promptInput) {
        promptInput.value = tmpl;
      }
    });
  });

  runGenBtn?.addEventListener('click', () => {
    const prompt = promptInput?.value.trim();
    if (!prompt) {
      if (window.showPageAlert) {
        window.showPageAlert({ type: 'warning', title: 'Prompt Required', message: 'Please describe your agent in plain language.' });
      } else {
        alert('Please describe your agent in plain language.');
      }
      return;
    }

    runGenBtn.textContent = 'Synthesizing...';

    setTimeout(() => {
      runGenBtn.textContent = 'Re-Synthesize';

      const generatedName = prompt.slice(0, 24).replace(/[^a-zA-Z0-9 ]/g, '') + ' AI';
      const generatedKeywords = ['automation', 'personal assistant', 'research'];

      generatedAgentData = {
        id: 'gen-agent-' + Date.now(),
        name: generatedName,
        slug: generatedName.toLowerCase().replace(/\\s+/g, '-'),
        description: prompt,
        category: 'automation',
        stack: 'uAgents / AFN',
        endpoint: `https://hosted.agentuniver.com/acp/${Date.now()}`,
        keywords: generatedKeywords,
        protocol: 'ACP v1.0',
        author: 'AI Synthesizer (Hosted)',
        rating: 5.0,
        runs: '1',
        trustTier: 'tier_0_new',
        acceptanceRate: 100,
        completedOrdersCount: 0,
        disputeCount: 0,
        verified: true,
        hosted: true,
        featured: false,
        createdAt: new Date().toISOString().split('T')[0],
        samplePrompt: prompt
      };

      if (genNameEl) genNameEl.textContent = generatedName;
      if (genDescEl) genDescEl.textContent = prompt;
      if (genKeywordsEl) {
        genKeywordsEl.innerHTML = generatedKeywords.map(k => `<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300">#${k}</span>`).join('');
      }

      previewBox?.classList.remove('hidden');
      publishGenBtn?.classList.remove('hidden');
    }, 700);
  });

  publishGenBtn?.addEventListener('click', () => {
    if (!generatedAgentData) return;
    try {
      const stored = localStorage.getItem('agentuniver_custom_agents') || '[]';
      const customAgents = JSON.parse(stored);
      customAgents.unshift(generatedAgentData);
      localStorage.setItem('agentuniver_custom_agents', JSON.stringify(customAgents));
    } catch (err) {
      console.error('Failed to save generated agent', err);
    }
    window.location.href = '/marketplace';
  });
}
