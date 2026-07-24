/** Escape a string so it can be embedded as a literal inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case-insensitive "contains" filter for a Mongo query from untrusted
 * user input. Escaping the input keeps it a literal substring match — no
 * ReDoS from attacker-supplied quantifiers, and special characters match
 * literally instead of silently changing the search semantics.
 */
export function containsRegex(search: string): { $regex: string; $options: string } {
  return { $regex: escapeRegExp(search), $options: 'i' };
}

/** Escape a string for safe interpolation into HTML text/attribute content. */
export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
