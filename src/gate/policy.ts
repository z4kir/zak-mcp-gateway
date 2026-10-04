import { GatewaySafetyConfig, DownstreamServerConfig } from "../config/schema.js";
import { DownstreamTool } from "../types/tool.js";
import { matchesAny } from "../util/glob.js";

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; needsConfirmation?: boolean };

/**
 * Safety policy, evaluated before any downstream call:
 *   - allow / deny lists (glob over namespaced names; deny wins; hidden tools are not even searchable)
 *   - global and per-server read-only mode (write tools blocked)
 *   - write confirmation (write tools need `confirm: true`)
 */
export class PolicyEngine {
  constructor(
    private safety: GatewaySafetyConfig,
    private servers: Record<string, Pick<DownstreamServerConfig, "readOnly">>
  ) {}

  public isVisible(tool: Pick<DownstreamTool, "namespacedName">): boolean {
    if (matchesAny(tool.namespacedName, this.safety.deny)) return false;
    if (this.safety.allow.length > 0 && !matchesAny(tool.namespacedName, this.safety.allow)) return false;
    return true;
  }

  public check(tool: DownstreamTool, confirmed: boolean, inCodeMode = false): PolicyDecision {
    if (!this.isVisible(tool)) {
      return { allowed: false, reason: `Tool "${tool.namespacedName}" is blocked by the gateway allow/deny policy.` };
    }
    if (tool.access === "read") return { allowed: true };

    if (this.safety.readOnly) {
      return { allowed: false, reason: `Gateway is in read-only mode; write tool "${tool.namespacedName}" is blocked.` };
    }
    if (this.servers[tool.serverId]?.readOnly) {
      return { allowed: false, reason: `Server "${tool.serverId}" is read-only; write tool "${tool.namespacedName}" is blocked.` };
    }
    if (this.safety.confirmWrites && !confirmed) {
      return inCodeMode
        ? { allowed: false, reason: `Write tool "${tool.namespacedName}" cannot run inside mcp_run_code while confirmWrites is on. Call it with mcp_call_tool and confirm: true.` }
        : {
            allowed: false,
            needsConfirmation: true,
            reason: `"${tool.namespacedName}" changes data. Confirm with the user, then repeat the same mcp_call_tool with "confirm": true.`
          };
    }
    return { allowed: true };
  }
}
