/**
 * Formats and renders execution output received from ACP 2.0 dispatch
 */
export function renderAcpExecutionOutput(acpData: any): { html: string; rawOutput: string } {
  if (!acpData) {
    return {
      html: '<div class="p-3 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 text-xs"><p class="font-bold text-amber-400 mb-1">Catalog Notice</p><p>Task dispatched to queue.</p></div>',
      rawOutput: ''
    };
  }

  if (acpData.success && acpData.output) {
    const out = acpData.output;
    const rawOutput = typeof out === 'string' ? out : JSON.stringify(out, null, 2);

    if (out.corrected) {
      let html = '<div class="space-y-2">';
      const scoreText = out.score ? (out.score * 100).toFixed(0) + '%' : '100%';
      html += `<div class="p-2.5 rounded-xl bg-slate-900 border border-slate-800"><span class="text-[10px] font-bold uppercase text-emerald-400 block mb-1">Polished Output (Score: ${scoreText})</span><p class="text-slate-200 font-sans leading-relaxed">${out.corrected}</p></div>`;

      if (out.issues && out.issues.length > 0) {
        html += `<div class="space-y-1"><span class="text-[10px] font-bold uppercase text-slate-400 block">Identified Improvements (${out.issues.length})</span>`;
        out.issues.forEach((iss: any) => {
          html += `<div class="text-[11px] p-1.5 rounded-lg bg-slate-900/60 border border-slate-800/60 flex items-start gap-1.5"><span class="text-amber-400 font-mono font-bold">[${iss.type || 'fix'}]</span><span class="text-slate-300 line-through">${iss.original || ''}</span> -> <span class="text-emerald-300 font-semibold">${iss.suggestion || ''}</span> <span class="text-slate-500 text-[10px]">(${iss.reason || ''})</span></div>`;
        });
        html += '</div>';
      }
      html += '</div>';
      return { html, rawOutput };
    } else {
      const html = `<pre class="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-[11px] text-emerald-300 font-mono whitespace-pre-wrap">${rawOutput}</pre>`;
      return { html, rawOutput };
    }
  }

  const fallbackMsg = (acpData.error && acpData.error.message) || 'Task dispatched to queue.';
  return {
    html: `<div class="p-3 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 text-xs"><p class="font-bold text-amber-400 mb-1">Catalog Notice</p><p>${fallbackMsg}</p></div>`,
    rawOutput: fallbackMsg
  };
}
