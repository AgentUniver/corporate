/**
 * HTML Entity Encoder to prevent XSS in innerHTML interpolations
 */
export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) {
    return '';
  }
  const str = typeof input === 'string' ? input : String(input);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
