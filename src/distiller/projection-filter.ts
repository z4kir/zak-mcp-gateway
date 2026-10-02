/**
 * Egress Projection Filter:
 * Extracts only requested fields from large JSON payloads.
 * Supports dot-notation paths (e.g. "status.name", "assignee.displayName").
 */
export class ProjectionFilter {
  public static project(data: unknown, fields?: string[]): unknown {
    if (!fields || fields.length === 0 || !data || typeof data !== "object") {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map(item => this.project(item, fields));
    }

    const projected: Record<string, unknown> = {};
    const obj = data as Record<string, unknown>;

    for (const field of fields) {
      if (field.includes(".")) {
        const parts = field.split(".");
        let current: unknown = obj;
        let valid = true;

        for (const part of parts) {
          if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
            current = (current as Record<string, unknown>)[part];
          } else {
            valid = false;
            break;
          }
        }

        if (valid) {
          this.setNested(projected, parts, current);
        }
      } else if (field in obj) {
        projected[field] = obj[field];
      }
    }

    return projected;
  }

  private static setNested(target: Record<string, unknown>, path: string[], value: unknown): void {
    let curr = target;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      if (!curr[seg] || typeof curr[seg] !== "object") {
        curr[seg] = {};
      }
      curr = curr[seg] as Record<string, unknown>;
    }
    curr[path[path.length - 1]] = value;
  }
}
