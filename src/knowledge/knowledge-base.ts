import * as fs from "node:fs";
import * as path from "node:path";
import MiniSearch from "minisearch";
import { log } from "../util/log.js";

export interface Skill {
  name: string;
  description: string;
  content: string;
}

const STOPWORDS = new Set(["a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "with", "my", "me", "i", "is", "are", "be", "it", "this", "that", "how", "do", "can", "please", "what", "show", "give"]);

/**
 * Rules and skills for every client, not just Claude Code:
 *   - rules: one text block sent in the instructions of every session
 *   - skills: an index (name + one line) in the instructions, full text on demand via
 *     mcp_get_skill, and the best-matching skill suggested in search results
 * Skills are read from a folder: <name>/SKILL.md or <name>.md, with optional front matter
 * (name:, description:).
 */
export class KnowledgeBase {
  public readonly rules: string;
  private skills = new Map<string, Skill>();
  private index = new MiniSearch<{ id: string; name: string; description: string }>({
    fields: ["name", "description"],
    storeFields: ["id"],
    tokenize: text => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s\p{P}\p{S}_]+/u).filter(Boolean),
    processTerm: term => {
      const t = term.toLowerCase();
      return STOPWORDS.has(t) ? null : t;
    },
    searchOptions: { boost: { name: 2 }, fuzzy: 0.2, prefix: true }
  });

  constructor(opts: { rules?: string; rulesFile?: string; skillsDir?: string; maxRulesChars: number }, baseDir: string) {
    let rules = opts.rules ?? "";
    if (opts.rulesFile) {
      try {
        rules = [rules, fs.readFileSync(path.resolve(baseDir, opts.rulesFile), "utf-8")].filter(Boolean).join("\n");
      } catch (err) {
        log.warn(`[knowledge] cannot read rulesFile: ${(err as Error).message}`);
      }
    }
    rules = rules.trim();
    if (rules.length > opts.maxRulesChars) {
      log.warn(`[knowledge] rules are ${rules.length} chars; cut to maxRulesChars (${opts.maxRulesChars}).`);
      rules = `${rules.slice(0, opts.maxRulesChars)}…`;
    }
    this.rules = rules;
    if (opts.skillsDir) this.loadSkills(path.resolve(baseDir, opts.skillsDir));
  }

  private loadSkills(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      log.warn(`[knowledge] cannot read skillsDir: ${(err as Error).message}`);
      return;
    }
    for (const e of entries) {
      const file = e.isDirectory() ? path.join(dir, e.name, "SKILL.md") : e.name.endsWith(".md") ? path.join(dir, e.name) : undefined;
      if (!file || !fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf-8");
      const skill = parseSkill(raw, e.isDirectory() ? e.name : e.name.replace(/\.md$/, ""));
      this.skills.set(skill.name, skill);
    }
    this.index.addAll([...this.skills.values()].map(s => ({ id: s.name, name: s.name, description: s.description })));
    log.info(`[knowledge] ${this.skills.size} skills loaded`);
  }

  public get hasSkills(): boolean {
    return this.skills.size > 0;
  }

  public getSkill(name: string): Skill | undefined {
    const exact = this.skills.get(name);
    if (exact) return exact;
    const lower = name.trim().toLowerCase();
    return [...this.skills.values()].find(s => s.name.toLowerCase() === lower);
  }

  public listSkills(): Skill[] {
    return [...this.skills.values()];
  }

  /** Best skill for a request, if at least half of the meaningful query words match it. */
  public match(query: string): Skill | undefined {
    const words = query.toLowerCase().split(/[\s\p{P}]+/u).filter(w => w && !STOPWORDS.has(w));
    if (words.length === 0) return undefined;
    const [best] = this.index.search(query);
    if (!best) return undefined;
    return best.terms.length / words.length >= 0.5 ? this.skills.get(best.id) : undefined;
  }

  /** Text for the session instructions. */
  public instructionsBlock(): string {
    const parts: string[] = [];
    if (this.rules) parts.push(`Rules:\n${this.rules}`);
    if (this.hasSkills) {
      parts.push(`Skills (call mcp_get_skill with the name before a matching task):\n${this.listSkills().map(s => `- ${s.name}: ${s.description}`).join("\n")}`);
    }
    return parts.join("\n");
  }
}

export function parseSkill(raw: string, fallbackName: string): Skill {
  let body = raw;
  let name = fallbackName;
  let description = "";
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      if (m[1] === "name" && m[2].trim()) name = m[2].trim().replace(/^["']|["']$/g, "");
      if (m[1] === "description") description = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (!description) {
    description = body.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith("#")) ?? "";
  }
  if (description.length > 160) description = `${description.slice(0, 159)}…`;
  return { name, description, content: body.trim() };
}
