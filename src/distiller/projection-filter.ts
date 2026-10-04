type PathTree = Map<string, PathTree>;

/**
 * Egress Projection Filter:
 * Keeps only the requested field paths. Dot paths walk through arrays automatically, so
 * on a list of commits ["sha", "commit.message"] keeps exactly those two fields per commit,
 * and on {total_count, items: [...]} the path "items.title" keeps each item's title.
 */
export class ProjectionFilter {
  public static project(data: unknown, fields?: string[]): unknown {
    if (!fields || fields.length === 0 || !data || typeof data !== "object") {
      return data;
    }
    return this.projectTree(data, this.buildTree(fields));
  }

  private static buildTree(fields: string[]): PathTree {
    const root: PathTree = new Map();
    for (const field of fields) {
      let node = root;
      for (const part of field.split(".").filter(Boolean)) {
        if (!node.has(part)) node.set(part, new Map());
        node = node.get(part)!;
      }
    }
    return root;
  }

  private static projectTree(value: unknown, tree: PathTree): unknown {
    if (tree.size === 0) return value; // leaf: keep the whole value
    if (Array.isArray(value)) return value.map(item => this.projectTree(item, tree));
    if (!value || typeof value !== "object") return undefined;

    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, subtree] of tree) {
      if (!(key in obj)) continue;
      const projected = this.projectTree(obj[key], subtree);
      if (projected !== undefined) out[key] = projected;
    }
    return out;
  }
}
