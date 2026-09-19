export function initFilterEngine() {
  const PAGE_SIZE = 6;
  let currentPage = 1;

  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  const sortSelect = document.getElementById('sort-select') as HTMLSelectElement | null;
  const categoryTabs = document.querySelectorAll('.category-tab');
  const agentCards = Array.from(document.querySelectorAll('.agent-card')) as HTMLElement[];
  const emptyState = document.getElementById('empty-state');
  const container = document.getElementById('agents-container');
  const btnFilterResultJobs = document.getElementById('btn-filter-result-jobs');

  // Load custom admitted/created agents from localStorage
  try {
    const customStored = localStorage.getItem('agentuniver_custom_agents');
    if (customStored && container) {
      const customList = JSON.parse(customStored);
      if (Array.isArray(customList) && customList.length > 0) {
        customList.slice().reverse().forEach((cAgent: any) => {
          if (document.querySelector(`[data-agent-id="${cAgent.id}"]`)) return;
          const cardEl = document.createElement('div');
          cardEl.className = 'agent-card group flex flex-col md:flex-row items-start md:items-center justify-between gap-5 bg-slate-900/90 hover:bg-slate-900 border border-slate-800/90 hover:border-emerald-500/50 rounded-3xl p-5 sm:p-6 transition-all duration-300 hover:shadow-xl hover:shadow-emerald-950/20 relative overflow-hidden';
          cardEl.setAttribute('data-category', cAgent.category || 'automation');
          cardEl.setAttribute('data-keywords', (cAgent.keywords || []).join(','));
          cardEl.setAttribute('data-name', (cAgent.name || '').toLowerCase());
          cardEl.setAttribute('data-agent-id', cAgent.id);
          cardEl.setAttribute('data-pricing-model', 'task_based');
          cardEl.setAttribute('data-trust-tier', cAgent.trustTier || 'tier_0_new');
          cardEl.setAttribute('data-interactions', '1');
          cardEl.setAttribute('data-rating', '5.0');
          cardEl.setAttribute('data-created', cAgent.createdAt || new Date().toISOString());

          cardEl.innerHTML = `
            <div class="flex items-start gap-4 sm:gap-5 flex-1 min-w-0">
              <div class="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-950 border border-slate-700/80 flex items-center justify-center text-lg sm:text-xl font-bold font-mono text-sky-400 shadow-inner group-hover:border-sky-500/50 transition flex-shrink-0">
                AI
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center gap-2 mb-1">
                  <h3 class="font-bold text-slate-100 text-base sm:text-lg leading-tight group-hover:text-emerald-400 transition truncate">
                    ${cAgent.name}
                  </h3>
                  <span class="text-xs font-mono text-sky-400 bg-sky-950/50 px-2.5 py-0.5 rounded-full border border-sky-800 truncate max-w-[220px]">
                    Autonomous Ingress
                  </span>
                </div>
                <p class="text-slate-400 text-xs sm:text-sm line-clamp-2 leading-relaxed mb-3">
                  ${cAgent.description}
                </p>
                <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
                  <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-800/80 border border-slate-700 text-slate-300 text-[11px] font-semibold">
                    <span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                    New Agent [Tier 0]
                  </span>
                  <span class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-950 text-slate-300 border border-slate-800">
                    ${cAgent.stack || 'ACP 2.0'}
                  </span>
                  ${(cAgent.keywords || []).slice(0, 3).map((k: string) => `<span class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-950 text-slate-400 border border-slate-800">${k}</span>`).join('')}
                </div>
              </div>
            </div>
            <div class="flex flex-col sm:flex-row md:flex-col items-end justify-between self-stretch md:self-auto gap-4 border-t md:border-t-0 border-slate-800/80 pt-4 md:pt-0">
              <div class="text-right">
                <div class="text-xs text-slate-500 font-mono">Dynamic Quote</div>
                <div class="text-lg font-bold text-white font-mono">$0.05 <span class="text-xs font-normal text-slate-400">/ loop</span></div>
              </div>
              <button 
                type="button" 
                class="btn-open-hire-modal w-full sm:w-auto px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition shadow-md shadow-emerald-600/30 cursor-pointer"
                data-agent-id="${cAgent.id}"
                data-agent-name="${cAgent.name}"
                data-base-price="0.05"
                data-pricing-model="task_based"
                data-payout-rail="${cAgent.payoutPreference?.rail || 'crypto_usdc'}"
                data-payout-address="${cAgent.payoutPreference?.accountIdentifier || '0xAU_Default_DID_Wallet'}"
              >
                Hire / Dispatch ->
              </button>
            </div>
          `;

          container.prepend(cardEl);
          agentCards.unshift(cardEl);

          cardEl.querySelector('.btn-open-hire-modal')?.addEventListener('click', (e) => {
            const btn = e.currentTarget as HTMLElement;
            window.dispatchEvent(new CustomEvent('open_agent_hire_modal', {
              detail: {
                agentId: btn.getAttribute('data-agent-id'),
                agentName: btn.getAttribute('data-agent-name'),
                basePrice: parseFloat(btn.getAttribute('data-base-price') || '0.05'),
                pricingModel: btn.getAttribute('data-pricing-model') || 'task_based',
                payoutRail: btn.getAttribute('data-payout-rail') || 'crypto_usdc',
                payoutAddress: btn.getAttribute('data-payout-address') || '0xAU_Default_DID_Wallet'
              }
            }));
          });
        });
      }
    }
  } catch (err) {
    console.error('Failed loading custom agents in marketplace', err);
  }

  const paginationControls = document.getElementById('pagination-controls');
  const paginationRange = document.getElementById('pagination-range');
  const paginationTotal = document.getElementById('pagination-total');
  const paginationCurrentPage = document.getElementById('pagination-current-page');
  const paginationTotalPages = document.getElementById('pagination-total-pages');
  const paginationNumbers = document.getElementById('pagination-numbers');
  const btnPrev = document.getElementById('btn-pagination-prev') as HTMLButtonElement | null;
  const btnNext = document.getElementById('btn-pagination-next') as HTMLButtonElement | null;

  let activeCategory = 'all';
  let searchQuery = '';

  document.getElementById('btn-trigger-login-hero')?.addEventListener('click', () => {
    window.dispatchEvent(new Event('open_auth_modal'));
  });

  function parseInteractions(val: string): number {
    if (!val) return 0;
    val = val.toUpperCase().trim();
    if (val.endsWith('K')) return parseFloat(val) * 1000;
    if (val.endsWith('M')) return parseFloat(val) * 1000000;
    return parseFloat(val) || 0;
  }

  function filterAndSort(shouldResetPage = false) {
    if (shouldResetPage) {
      currentPage = 1;
    }

    // 1. Filter cards
    const matchingCards: HTMLElement[] = [];
    agentCards.forEach(card => {
      const cat = card.getAttribute('data-category') || '';
      const pricingModel = card.getAttribute('data-pricing-model') || '';
      const name = (card.getAttribute('data-name') || '').toLowerCase();
      const keywords = (card.getAttribute('data-keywords') || '').toLowerCase();

      let matchCat = activeCategory === 'all';
      if (activeCategory === 'result_based') {
        matchCat = pricingModel === 'result_based';
      } else if (!matchCat) {
        matchCat = cat.toLowerCase() === activeCategory.toLowerCase();
      }

      const matchSearch = !searchQuery || name.includes(searchQuery) || keywords.includes(searchQuery);

      if (matchCat && matchSearch) {
        matchingCards.push(card);
      } else {
        card.style.display = 'none';
      }
    });

    const totalMatches = matchingCards.length;

    // 2. Sort matching cards
    const sortVal = sortSelect?.value || 'relevance';
    matchingCards.sort((a, b) => {
      if (sortVal === 'trust_tier') {
        const tierWeights: Record<string, number> = {
          tier_3_certified: 4,
          tier_2_top_rated: 3,
          tier_1_rising: 2,
          tier_0_new: 1
        };
        const tA = tierWeights[a.getAttribute('data-trust-tier') || 'tier_0_new'] || 1;
        const tB = tierWeights[b.getAttribute('data-trust-tier') || 'tier_0_new'] || 1;
        if (tB !== tA) return tB - tA;
        const rA = parseFloat(a.getAttribute('data-rating') || '0');
        const rB = parseFloat(b.getAttribute('data-rating') || '0');
        return rB - rA;
      }
      if (sortVal === 'interactions') {
        const iA = parseInteractions(a.getAttribute('data-interactions') || '0');
        const iB = parseInteractions(b.getAttribute('data-interactions') || '0');
        return iB - iA;
      }
      if (sortVal === 'rating') {
        const rA = parseFloat(a.getAttribute('data-rating') || '0');
        const rB = parseFloat(b.getAttribute('data-rating') || '0');
        return rB - rA;
      }
      if (sortVal === 'newest') {
        const dA = new Date(a.getAttribute('data-created') || '').getTime();
        const dB = new Date(b.getAttribute('data-created') || '').getTime();
        return dB - dA;
      }
      return 0;
    });

    // 3. Handle Empty State
    if (totalMatches === 0) {
      emptyState?.classList.remove('hidden');
      paginationControls?.classList.add('hidden');
      return;
    } else {
      emptyState?.classList.add('hidden');
      paginationControls?.classList.remove('hidden');
    }

    // 4. Pagination calculations
    const totalPages = Math.ceil(totalMatches / PAGE_SIZE) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIndex = (currentPage - 1) * PAGE_SIZE;
    const endIndex = Math.min(startIndex + PAGE_SIZE, totalMatches);

    // Re-order and display slice in DOM
    matchingCards.forEach((card, idx) => {
      if (idx >= startIndex && idx < endIndex) {
        card.style.display = 'flex';
        container?.appendChild(card);
      } else {
        card.style.display = 'none';
      }
    });

    // 5. Update pagination UI
    if (paginationRange) paginationRange.textContent = `${startIndex + 1}-${endIndex}`;
    if (paginationTotal) paginationTotal.textContent = `${totalMatches}`;
    if (paginationCurrentPage) paginationCurrentPage.textContent = `${currentPage}`;
    if (paginationTotalPages) paginationTotalPages.textContent = `${totalPages}`;

    if (btnPrev) btnPrev.disabled = currentPage <= 1;
    if (btnNext) btnNext.disabled = currentPage >= totalPages;

    renderPageNumbers(totalPages);

    // Sync URL param
    const url = new URL(window.location.href);
    url.searchParams.set('page', String(currentPage));
    if (activeCategory !== 'all') {
      url.searchParams.set('category', activeCategory);
    } else {
      url.searchParams.delete('category');
    }
    history.replaceState(null, '', url.toString());
  }

  function renderPageNumbers(totalPages: number) {
    if (!paginationNumbers) return;
    paginationNumbers.innerHTML = '';

    for (let p = 1; p <= totalPages; p++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = String(p);
      btn.className = p === currentPage
        ? 'w-8 h-8 rounded-xl bg-emerald-600 text-white font-semibold text-xs shadow-sm shadow-emerald-600/30 flex items-center justify-center transition-all duration-300 ease-out active:scale-[0.98] cursor-pointer'
        : 'w-8 h-8 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700 font-semibold text-xs flex items-center justify-center transition-all duration-300 ease-out active:scale-[0.98] cursor-pointer';

      btn.addEventListener('click', () => {
        if (currentPage !== p) {
          currentPage = p;
          filterAndSort(false);
          scrollToAgentsTop();
        }
      });
      paginationNumbers.appendChild(btn);
    }
  }

  function scrollToAgentsTop() {
    const listTop = document.getElementById('agents-container');
    if (listTop) {
      const pos = listTop.getBoundingClientRect().top + window.scrollY - 90;
      window.scrollTo({ top: pos, behavior: 'smooth' });
    }
  }

  btnPrev?.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      filterAndSort(false);
      scrollToAgentsTop();
    }
  });

  btnNext?.addEventListener('click', () => {
    currentPage++;
    filterAndSort(false);
    scrollToAgentsTop();
  });

  function selectCategory(catId: string) {
    categoryTabs.forEach(t => {
      if (t.getAttribute('data-category-id') === catId) {
        t.classList.remove('bg-slate-900', 'text-slate-400', 'border', 'border-slate-800');
        t.classList.add('bg-emerald-600', 'text-white', 'shadow-sm', 'shadow-emerald-600/30');
      } else {
        t.classList.remove('bg-emerald-600', 'text-white', 'shadow-sm', 'shadow-emerald-600/30');
        t.classList.add('bg-slate-900', 'text-slate-400', 'border', 'border-slate-800');
      }
    });
    activeCategory = catId;
    filterAndSort(true);
  }

  searchInput?.addEventListener('input', (e) => {
    searchQuery = (e.target as HTMLInputElement).value.toLowerCase().trim();
    filterAndSort(true);
  });

  sortSelect?.addEventListener('change', () => {
    filterAndSort(false);
  });

  categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const catId = tab.getAttribute('data-category-id') || 'all';
      selectCategory(catId);
    });
  });

  btnFilterResultJobs?.addEventListener('click', () => {
    selectCategory('result_based');
    scrollToAgentsTop();
  });

  const urlParams = new URLSearchParams(window.location.search);
  const initialCategory = urlParams.get('category');
  const initialPage = parseInt(urlParams.get('page') || '1', 10);
  if (initialPage > 0) {
    currentPage = initialPage;
  }
  if (initialCategory) {
    selectCategory(initialCategory);
  } else {
    filterAndSort(false);
  }
}
