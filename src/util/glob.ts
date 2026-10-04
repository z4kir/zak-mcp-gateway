const compiled = new Map<string, RegExp>();

/** Minimal glob matcher: `*` matches any run of characters, everything else is literal. */
export function globToRegExp(pattern: string): RegExp {
  let re = compiled.get(pattern);
  if (!re) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
    re = new RegExp(`^${escaped}$`, "i");
    compiled.set(pattern, re);
  }
  return re;
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some(p => globToRegExp(p).test(value));
}
