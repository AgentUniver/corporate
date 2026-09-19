export function initWizardController() {
  const stepIndicators = document.querySelectorAll('.step-indicator');
  const stepPanes = document.querySelectorAll('.step-pane');
  const nextButtons = document.querySelectorAll('.btn-next-step');
  const prevButtons = document.querySelectorAll('.btn-prev-step');

  const inputName = document.getElementById('input-agent-name') as HTMLInputElement | null;
  const inputEndpoint = document.getElementById('input-agent-endpoint') as HTMLInputElement | null;
  const inputCategory = document.getElementById('input-agent-category') as HTMLSelectElement | null;
  const inputAuthor = document.getElementById('input-agent-author') as HTMLInputElement | null;
  const inputDesc = document.getElementById('input-agent-desc') as HTMLTextAreaElement | null;
  const charCount = document.getElementById('char-count');
  const btnValidateStep2 = document.getElementById('btn-validate-step-2');

  const customKwInput = document.getElementById('custom-keyword-input') as HTMLInputElement | null;
  const addCustomKwBtn = document.getElementById('add-custom-kw-btn');
  const kwChips = document.querySelectorAll('.wizard-kw-chip');
  const kwContainer = document.getElementById('selectable-keywords-container');
  const kwCounterBadge = document.getElementById('keyword-counter-badge');
  const btnValidateStep3 = document.getElementById('btn-validate-step-3');
  let selectedKeywords: string[] = [];

  const verifyEndpointLabel = document.getElementById('verify-endpoint-label');
  const wizardCodePreview = document.getElementById('wizard-code-preview');
  const copyWizardCodeBtn = document.getElementById('copy-wizard-code-btn');
  const btnTestHandshake = document.getElementById('btn-test-handshake');
  const handshakeSpinner = document.getElementById('handshake-spinner');
  const handshakeResult = document.getElementById('handshake-result');
  const btnPublishAgent = document.getElementById('btn-publish-agent');
  const inputPayoutRail = document.getElementById('input-agent-payout-rail') as HTMLSelectElement | null;
  const inputPayoutAddr = document.getElementById('input-agent-payout-addr') as HTMLInputElement | null;
  const labelPayoutAccount = document.getElementById('label-payout-account');

  inputPayoutRail?.addEventListener('change', () => {
    const val = inputPayoutRail.value;
    if (val === 'crypto_usdc') {
      if (labelPayoutAccount) labelPayoutAccount.textContent = 'Payout Identifier (EVM L2 Address)';
      if (inputPayoutAddr) inputPayoutAddr.placeholder = 'e.g., 0x71C... (Base / Arbitrum)';
    } else if (val === 'fiat_stripe') {
      if (labelPayoutAccount) labelPayoutAccount.textContent = 'Stripe Account ID or Bank IBAN';
      if (inputPayoutAddr) inputPayoutAddr.placeholder = 'acct_... or US Routing/Account';
    } else if (val === 'fiat_wise') {
      if (labelPayoutAccount) labelPayoutAccount.textContent = 'Wise Registered Email';
      if (inputPayoutAddr) inputPayoutAddr.placeholder = 'developer@domain.com';
    } else if (val === 'fiat_payoneer') {
      if (labelPayoutAccount) labelPayoutAccount.textContent = 'Payoneer Payee ID';
      if (inputPayoutAddr) inputPayoutAddr.placeholder = '10029384';
    }
  });

  function goToStep(stepNum: number) {
    stepPanes.forEach(pane => pane.classList.add('hidden'));
    const activePane = document.getElementById(`step-${stepNum}`);
    if (activePane) activePane.classList.remove('hidden');

    stepIndicators.forEach(ind => {
      const target = parseInt(ind.getAttribute('data-step-target') || '1', 10);
      const circle = ind.querySelector('span');
      if (target === stepNum) {
        ind.classList.add('text-emerald-400');
        ind.classList.remove('text-slate-500');
        circle?.classList.add('bg-emerald-600', 'text-white');
        circle?.classList.remove('bg-slate-800', 'text-slate-400');
      } else if (target < stepNum) {
        ind.classList.add('text-emerald-400');
        ind.classList.remove('text-slate-500');
        circle?.classList.add('bg-emerald-700', 'text-white');
        circle?.classList.remove('bg-slate-800', 'text-slate-400');
      } else {
        ind.classList.remove('text-emerald-400');
        ind.classList.add('text-slate-500');
        circle?.classList.remove('bg-emerald-600', 'text-white', 'bg-emerald-700');
        circle?.classList.add('bg-slate-800', 'text-slate-400');
      }
    });

    if (stepNum === 4) {
      updateStep4Summary();
    }
  }

  nextButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = parseInt(btn.getAttribute('data-next') || '1', 10);
      goToStep(next);
    });
  });

  prevButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const prev = parseInt(btn.getAttribute('data-prev') || '1', 10);
      goToStep(prev);
    });
  });

  inputName?.addEventListener('input', () => {
    if (charCount && inputName) charCount.textContent = `${inputName.value.length} / 30`;
  });

  btnValidateStep2?.addEventListener('click', () => {
    if (!inputName || !inputName.value.trim()) {
      if (window.showPageAlert) {
        window.showPageAlert({ type: 'warning', title: 'Input Required', message: 'Please enter a valid Agent Name (max 30 characters).' });
      } else {
        alert('Please enter a valid Agent Name (max 30 characters).');
      }
      inputName?.focus();
      return;
    }
    if (!inputEndpoint || !inputEndpoint.value.trim()) {
      if (window.showPageAlert) {
        window.showPageAlert({ type: 'warning', title: 'Input Required', message: 'Please enter your Agent Endpoint URL.' });
      } else {
        alert('Please enter your Agent Endpoint URL.');
      }
      inputEndpoint?.focus();
      return;
    }
    goToStep(3);
  });

  function updateKeywordUI() {
    if (kwCounterBadge) {
      kwCounterBadge.textContent = `${selectedKeywords.length} / 3 selected (${selectedKeywords.length >= 3 ? 'Valid' : 'Min 3 required'})`;
      if (selectedKeywords.length >= 3) {
        kwCounterBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30';
      } else {
        kwCounterBadge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30';
      }
    }
  }

  kwChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const kw = chip.getAttribute('data-keyword');
      if (!kw) return;

      if (selectedKeywords.includes(kw)) {
        selectedKeywords = selectedKeywords.filter(k => k !== kw);
        chip.classList.remove('bg-emerald-600', 'text-white', 'border-emerald-500');
        chip.classList.add('bg-slate-950', 'text-slate-400', 'border-slate-800');
      } else {
        selectedKeywords.push(kw);
        chip.classList.add('bg-emerald-600', 'text-white', 'border-emerald-500');
        chip.classList.remove('bg-slate-950', 'text-slate-400', 'border-slate-800');
      }
      updateKeywordUI();
    });
  });

  addCustomKwBtn?.addEventListener('click', () => {
    if (!customKwInput) return;
    const customVal = customKwInput.value.trim().toLowerCase();
    if (!customVal) return;
    if (!selectedKeywords.includes(customVal)) {
      selectedKeywords.push(customVal);
      const newChip = document.createElement('button');
      newChip.type = 'button';
      newChip.className = 'wizard-kw-chip px-3.5 py-2 rounded-xl text-xs font-medium bg-emerald-600 text-white border border-emerald-500 transition';
      newChip.setAttribute('data-keyword', customVal);
      newChip.textContent = `#${customVal}`;
      newChip.addEventListener('click', () => {
        selectedKeywords = selectedKeywords.filter(k => k !== customVal);
        newChip.remove();
        updateKeywordUI();
      });
      kwContainer?.appendChild(newChip);
    }
    customKwInput.value = '';
    updateKeywordUI();
  });

  btnValidateStep3?.addEventListener('click', () => {
    if (selectedKeywords.length < 3) {
      if (window.showPageAlert) {
        window.showPageAlert({ type: 'warning', title: 'Keywords Required', message: 'Please select at least 3 keywords to help users discover your agent.' });
      } else {
        alert('Please select at least 3 keywords to help users discover your agent.');
      }
      return;
    }
    goToStep(4);
  });

  function updateStep4Summary() {
    const endpoint = inputEndpoint?.value.trim() || 'https://my-agent.com/acp/v1';
    const name = inputName?.value.trim() || 'my_connected_agent';
    const selectedStack = (document.querySelector('input[name="agent_stack"]:checked') as HTMLInputElement)?.value || 'uAgents / AFN';

    if (verifyEndpointLabel) verifyEndpointLabel.textContent = endpoint;

    if (wizardCodePreview) {
      wizardCodePreview.textContent = `import os
from uagents import Agent, Context, Model

# Agent Identity: ${name}
# Stack: ${selectedStack}
# Keywords: ${selectedKeywords.join(', ')}

class Message(Model):
    text: str

agent = Agent(
    name="${name.toLowerCase().replace(/\\s+/g, '_')}",
    seed=os.getenv("AGENT_SEED_PHRASE", "your_secret_mnemonic_phrase"),
    endpoint=["${endpoint}"]
)

@agent.on_message(model=Message)
async def handle_incoming(ctx: Context, sender: str, msg: Message):
    ctx.logger.info(f"Received ACP request from {sender}: {msg.text}")
    # Process with your custom tools and LLM
    await ctx.send(sender, Message(text=f"Response from ${name}: Handled '{msg.text}'"))

if __name__ == "__main__":
    agent.run()`;
    }
  }

  copyWizardCodeBtn?.addEventListener('click', () => {
    const code = wizardCodePreview?.textContent;
    if (code) {
      navigator.clipboard.writeText(code);
      copyWizardCodeBtn.textContent = 'Copied!';
      setTimeout(() => { copyWizardCodeBtn.textContent = 'Copy Snippet'; }, 2000);
    }
  });

  btnTestHandshake?.addEventListener('click', () => {
    if (handshakeSpinner) handshakeSpinner.classList.remove('hidden');
    if (handshakeResult) handshakeResult.classList.add('hidden');

    setTimeout(() => {
      if (handshakeSpinner) handshakeSpinner.classList.add('hidden');
      if (handshakeResult) handshakeResult.classList.remove('hidden');
    }, 800);
  });

  btnPublishAgent?.addEventListener('click', () => {
    const name = inputName?.value.trim() || 'Custom Agent';
    const endpoint = inputEndpoint?.value.trim() || 'https://my-agent.com/acp/v1';
    const category = inputCategory?.value || 'automation';
    const author = inputAuthor?.value.trim() || 'Community Developer';
    const desc = inputDesc?.value.trim() || `Autonomous agent providing ${category} intelligence on the AgentUniver network.`;
    const selectedStack = (document.querySelector('input[name="agent_stack"]:checked') as HTMLInputElement)?.value || 'uAgents / AFN';

    const payoutRail = inputPayoutRail?.value || 'crypto_usdc';
    const payoutAddress = inputPayoutAddr?.value.trim() || '0xAU_Default_DID_Wallet';

    const newAgent = {
      id: 'agent-' + Date.now(),
      name: name,
      slug: name.toLowerCase().replace(/\\s+/g, '-'),
      description: desc,
      category: category,
      stack: selectedStack,
      endpoint: endpoint,
      keywords: selectedKeywords,
      protocol: 'ACP v1.0',
      author: author,
      rating: 5.0,
      runs: '1',
      trustTier: 'tier_0_new',
      acceptanceRate: 100,
      completedOrdersCount: 0,
      disputeCount: 0,
      verified: true,
      hosted: false,
      featured: false,
      payoutPreference: {
        rail: payoutRail,
        accountIdentifier: payoutAddress,
        minimumThresholdUsd: 20
      },
      createdAt: new Date().toISOString().split('T')[0],
      samplePrompt: `Hello ${name}, please run your default agent task.`
    };

    try {
      const stored = localStorage.getItem('agentuniver_custom_agents') || '[]';
      const customAgents = JSON.parse(stored);
      customAgents.unshift(newAgent);
      localStorage.setItem('agentuniver_custom_agents', JSON.stringify(customAgents));
    } catch (err) {
      console.error('Failed to save custom agent', err);
    }

    window.location.href = '/marketplace';
  });

  return {
    goToStep
  };
}
