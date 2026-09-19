import { 
  getHiredTaskOrders, 
  verifyAndAcceptOrder, 
  disputeOrder, 
  deliverTaskResult,
  refundDisputedOrder
} from '../supabase';

export function setupOrdersDrawer() {
  const drawer = document.getElementById('orders-drawer');
  const closeBtn = document.getElementById('close-orders-drawer');
  const listContainer = document.getElementById('orders-list-container');

  function closeDrawer() {
    if (drawer) {
      drawer.classList.add('hidden');
    }
  }

  function openDrawer() {
    if (drawer) {
      drawer.classList.remove('hidden');
    }
    renderOrders();
  }

  // Expose to window for direct invocation
  (window as any).openOrdersDrawer = openDrawer;
  (window as any).closeOrdersDrawer = closeDrawer;

  closeBtn?.addEventListener('click', closeDrawer);
  drawer?.addEventListener('click', (e) => {
    if (e.target === drawer) closeDrawer();
  });

  window.addEventListener('open_orders_drawer', openDrawer);

  const navOrdersBtn = document.getElementById('btn-view-hired-tasks');
  navOrdersBtn?.addEventListener('click', openDrawer);

  window.addEventListener('agentuniver_tasks_updated', () => {
    if (drawer && !drawer.classList.contains('hidden')) {
      renderOrders();
    }
  });

  async function renderOrders() {
    if (!listContainer) return;
    try {
      const orders = await getHiredTaskOrders();

      if (!orders || orders.length === 0) {
        listContainer.innerHTML = `
          <div class="text-center py-16 px-4 bg-slate-950/40 rounded-2xl border border-slate-800">
            <div class="w-10 h-10 rounded-xl bg-slate-800 text-slate-400 flex items-center justify-center mx-auto mb-3 font-mono font-bold text-xs">
              AU
            </div>
            <h4 class="text-sm font-bold text-white">No Hired Orders Yet</h4>
            <p class="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
              Explore the marketplace or Enterprise Jobs to delegate tasks with SLA result protection.
            </p>
          </div>
        `;
        return;
      }

      listContainer.innerHTML = orders.map(order => {
        const isResultBased = order.orderType === 'result_based' || order.parameters?.orderType === 'result_based';
        const volumeText = isResultBased && order.quantity 
          ? `${order.quantity} ${order.resultMetric || 'Units'}` 
          : '1 Autonomous Task';
        
        let statusBadgeClass = 'bg-slate-800 text-slate-300 border-slate-700';
        let statusLabel = order.status.toUpperCase();

        if (order.status === 'escrowed') {
          statusBadgeClass = 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30';
          statusLabel = 'ESCROW LOCKED';
        } else if (order.status === 'processing') {
          statusBadgeClass = 'bg-blue-500/10 text-blue-400 border-blue-500/30';
          statusLabel = 'PROCESSING';
        } else if (order.status === 'delivered') {
          statusBadgeClass = 'bg-purple-500/10 text-purple-300 border-purple-500/30';
          statusLabel = 'DELIVERED (PENDING REVIEW)';
        } else if (order.status === 'verified') {
          statusBadgeClass = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
          statusLabel = 'VERIFIED & SETTLED';
        } else if (order.status === 'disputed') {
          statusBadgeClass = 'bg-rose-500/10 text-rose-400 border-rose-500/30';
          statusLabel = 'DISPUTED (UNDER REVIEW)';
        } else if (order.status === 'refunded') {
          statusBadgeClass = 'bg-amber-500/10 text-amber-400 border-amber-500/30';
          statusLabel = 'REFUNDED TO CLIENT';
        }

        return `
          <div class="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
            <div class="flex items-start justify-between gap-2">
              <div>
                <div class="flex items-center gap-2">
                  <span class="font-bold text-white text-sm">${order.agentName || 'Autonomous Agent'}</span>
                  <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${statusBadgeClass} border">
                    ${statusLabel}
                  </span>
                </div>
                <div class="text-[11px] text-slate-400 font-mono mt-0.5">
                  Order ID: ${order.id} • ${new Date(order.createdAt).toLocaleString()}
                </div>
              </div>
              <div class="text-right flex-shrink-0">
                <span class="text-sm font-mono font-bold text-white">$${Number(order.budgetUsd).toFixed(2)}</span>
                <span class="text-[10px] text-slate-400 block">USDC</span>
              </div>
            </div>

            <div class="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 text-xs space-y-1">
              <div class="flex justify-between text-slate-400 text-[11px]">
                <span>Scope / Volume:</span>
                <span class="font-semibold text-slate-200">${volumeText}</span>
              </div>
              ${order.priceCeilingUsd ? `
                <div class="flex justify-between text-slate-400 text-[11px]">
                  <span>Ceiling Cap (Locked):</span>
                  <span class="text-emerald-400 font-mono font-bold">$${Number(order.priceCeilingUsd).toFixed(2)} USD</span>
                </div>
              ` : ''}
              ${(order.costBreakdown && order.costBreakdown.refundedRemainder && order.costBreakdown.refundedRemainder > 0) ? `
                <div class="flex justify-between text-slate-400 text-[11px]">
                  <span>Unspent Instant Refund:</span>
                  <span class="text-sky-400 font-mono font-bold">+$${Number(order.costBreakdown.refundedRemainder).toFixed(2)} USD</span>
                </div>
              ` : ''}
              ${order.slaThreshold ? `
                <div class="flex justify-between text-slate-400 text-[11px]">
                  <span>SLA Guarantee:</span>
                  <span class="text-cyan-300 font-mono">${order.slaThreshold}</span>
                </div>
              ` : ''}
              <div class="text-slate-300 text-[11px] pt-1 border-t border-slate-800 truncate">
                Prompt/Spec: ${order.taskDescription || 'Standard parameters'}
              </div>
            </div>

            ${order.deliverableFingerprint ? `
              <div class="p-2 rounded-lg bg-emerald-950/20 border border-emerald-500/30 text-[11px] space-y-1">
                <div class="flex items-center justify-between">
                  <span class="font-bold text-emerald-400">SHA-256 Verified Fingerprint</span>
                  <span class="text-xs font-mono font-bold text-emerald-300">${order.deliverableFingerprint.integrityScore}/100 Score</span>
                </div>
                <div class="font-mono text-[10px] text-slate-400 truncate">
                  Hash: ${order.deliverableFingerprint.sha256Checksum}
                </div>
              </div>
            ` : ''}

            ${order.disputeReason ? `
              <div class="p-2.5 rounded-lg bg-rose-950/30 border border-rose-800/50 text-[11px] text-rose-300 space-y-1">
                <span class="font-bold block uppercase tracking-wider">Dispute Reason:</span>
                <p>${order.disputeReason}</p>
              </div>
            ` : ''}

            ${order.arbitrationVerdict ? `
              <div class="p-2.5 rounded-lg bg-indigo-950/40 border border-indigo-500/40 text-[11px] space-y-1.5">
                <div class="flex items-center justify-between">
                  <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 uppercase">
                    Arbitration: ${order.arbitrationVerdict.ruling.replace('_', ' ')}
                  </span>
                  <span class="text-slate-400 font-mono text-[10px]">Confidence: ${Math.round(order.arbitrationVerdict.confidence * 100)}%</span>
                </div>
                <p class="text-slate-300 leading-relaxed">${order.arbitrationVerdict.rationale}</p>
                <div class="text-[10px] font-mono text-slate-500 truncate">Evidence: ${order.arbitrationVerdict.evidenceHash}</div>
              </div>
            ` : ''}

            ${order.resultPayload ? `
              <div class="p-2.5 rounded-lg bg-purple-950/20 border border-purple-800/40 text-[11px] text-purple-300 space-y-1">
                <div class="flex justify-between font-bold">
                  <span>Deliverable Result Payload:</span>
                  <span class="text-emerald-400">${order.resultPayload.verifiedCount || order.quantity || 0} Units Ready</span>
                </div>
                <div class="text-slate-300 font-mono text-[10px] bg-slate-950/80 p-2 rounded max-h-24 overflow-y-auto">
                  ${JSON.stringify(order.resultPayload, null, 2)}
                </div>
              </div>
            ` : ''}

            <!-- Action Controls based on Status -->
            <div class="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-900 text-xs">
              ${(order.status === 'escrowed' || order.status === 'processing') ? `
                <button 
                  data-action="simulate-delivery" 
                  data-order-id="${order.id}" 
                  class="px-3 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/40 font-semibold text-[11px] transition cursor-pointer"
                >
                  Deliver Results (Simulate)
                </button>
              ` : ''}

              ${order.status === 'delivered' ? `
                <button 
                  data-action="verify-order" 
                  data-order-id="${order.id}" 
                  class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-[11px] transition shadow-sm shadow-emerald-600/30 cursor-pointer"
                >
                  Verify & Settle Escrow
                </button>
                <button 
                  data-action="dispute-order" 
                  data-order-id="${order.id}" 
                  class="px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40 font-semibold text-[11px] transition cursor-pointer"
                >
                  Raise SLA Dispute
                </button>
              ` : ''}

              ${order.status === 'disputed' ? `
                <button 
                  data-action="refund-order" 
                  data-order-id="${order.id}" 
                  class="px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/40 font-semibold text-[11px] transition cursor-pointer"
                >
                  Release Refund to Client
                </button>
              ` : ''}

              ${order.status === 'verified' ? `
                <span class="text-emerald-400 font-mono text-[11px] font-semibold">
                  Payment Released to Developer
                </span>
              ` : ''}
            </div>

          </div>
        `;
      }).join('');

      // Review Gate Modal Bindings
      const reviewGate = document.getElementById('drawer-review-gate');
      const btnCloseReviewGate = document.getElementById('btn-close-review-gate');
      const formReviewGate = document.getElementById('form-review-gate');
      const reviewInputOrderId = document.getElementById('review-input-order-id') as HTMLInputElement | null;

      btnCloseReviewGate?.addEventListener('click', () => {
        reviewGate?.classList.add('hidden');
      });

      formReviewGate?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const oId = reviewInputOrderId?.value;
        const sClarity = parseInt((document.getElementById('review-score-clarity') as HTMLSelectElement)?.value || '5', 10);
        const sQuality = parseInt((document.getElementById('review-score-quality') as HTMLSelectElement)?.value || '5', 10);
        const sLatency = parseInt((document.getElementById('review-score-latency') as HTMLSelectElement)?.value || '5', 10);
        const sValue = parseInt((document.getElementById('review-score-value') as HTMLSelectElement)?.value || '5', 10);
        const comment = (document.getElementById('review-input-comment') as HTMLTextAreaElement)?.value || '';

        const reviewEntry = {
          orderId: oId,
          scores: { clarity: sClarity, quality: sQuality, latency: sLatency, value: sValue },
          overallScore: parseFloat(((sClarity + sQuality + sLatency + sValue) / 4).toFixed(1)),
          comment: comment.trim(),
          reviewedAt: new Date().toISOString()
        };

        try {
          const revs = JSON.parse(localStorage.getItem('agentuniver_agent_reviews') || '[]');
          revs.unshift(reviewEntry);
          localStorage.setItem('agentuniver_agent_reviews', JSON.stringify(revs));
        } catch (err) {}

        if (oId) {
          await verifyAndAcceptOrder(oId);
        }
        reviewGate?.classList.add('hidden');
        renderOrders();
      });

      // Attach event listeners to dynamic buttons
      listContainer.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const action = (e.currentTarget as HTMLElement).getAttribute('data-action');
          const orderId = (e.currentTarget as HTMLElement).getAttribute('data-order-id');
          if (!orderId) return;

          if (action === 'simulate-delivery') {
            await deliverTaskResult(orderId, {
              status: 'COMPLETED',
              deliveredTimestamp: new Date().toISOString(),
              verifiedCount: 500,
              dataDeliverySample: 'Verified ICP Corporate Email & Authority Records Package ready for download.'
            });
            renderOrders();
          } else if (action === 'verify-order') {
            if (reviewInputOrderId) reviewInputOrderId.value = orderId;
            reviewGate?.classList.remove('hidden');
          } else if (action === 'dispute-order') {
            const reason = prompt('Please state the SLA non-compliance reason (e.g. Email bounce rate exceeded 15%):');
            if (reason && reason.trim()) {
              await disputeOrder(orderId, reason.trim());
              renderOrders();
            }
          } else if (action === 'refund-order') {
            await refundDisputedOrder(orderId);
            renderOrders();
          }
        });
      });
    } catch (err) {
      console.error('Error rendering orders:', err);
    }
  }
}
