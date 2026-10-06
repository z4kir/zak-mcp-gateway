import { CallRecord } from "./token-stats.js";

export interface FlowStep {
  tool: string;
  repeat: number;
}

/**
 * Find repeated call sequences (3-6 steps, consecutive repeats of one tool folded into
 * "×n") across sessions, and turn the longest ones into workflow skeletons.
 */
export function suggestWorkflows(calls: CallRecord[]): { steps: FlowStep[]; count: number; skeleton: Record<string, unknown> }[] {
  const bySession = new Map<string, FlowStep[]>();
  for (const c of calls) {
    if (c.blocked || !["call", "batch", "direct", "pinned"].includes(c.via)) continue;
    const seq = bySession.get(c.session) ?? [];
    const last = seq[seq.length - 1];
    if (last && last.tool === c.tool) last.repeat++;
    else seq.push({ tool: c.tool, repeat: 1 });
    bySession.set(c.session, seq);
  }

  const counts = new Map<string, { steps: FlowStep[]; count: number }>();
  for (const seq of bySession.values()) {
    for (let len = 3; len <= 6; len++) {
      for (let i = 0; i + len <= seq.length; i++) {
        const steps = seq.slice(i, i + len);
        const key = steps.map(s => `${s.tool}${s.repeat > 1 ? "*" : ""}`).join(">");
        const hit = counts.get(key) ?? { steps: steps.map(s => ({ ...s })), count: 0 };
        hit.count++;
        counts.set(key, hit);
      }
    }
  }
  const frequent = [...counts].filter(([, v]) => v.count >= 2);
  // Keep only sequences not contained in a longer frequent one.
  const maximal = frequent.filter(([key]) => !frequent.some(([other]) => other !== key && other.includes(key)));
  return maximal
    .sort((a, b) => b[1].steps.length * b[1].count - a[1].steps.length * a[1].count)
    .slice(0, 5)
    .map(([, v]) => {
      const first = v.steps[0].tool.split("__").pop() ?? "steps";
      const skeleton = {
        [`${first}_flow`]: {
          description: "TODO: when to use this, and when not to",
          input: { properties: {}, required: [] },
          steps: v.steps.map((s, i) => ({
            id: `s${i + 1}`,
            tool: s.tool,
            ...(s.repeat > 1 ? { forEach: "${input.items}" } : {}),
            arguments: {}
          }))
        }
      };
      return { ...v, skeleton };
    });
}
