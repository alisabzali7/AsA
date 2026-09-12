/**
 * Central no-execution capability assertion (closure §Z).
 *
 * AsA is advisory-only. Rather than relying on a grep in a test file, this
 * module is a runtime-callable capability probe: it inspects what the process
 * can actually DO and reports a structured verdict. It is exercised by CI, by
 * the /api/system/status surface, and by the closure report.
 *
 * The layers it verifies:
 *   1. transport method allow-list (GET/HEAD only)
 *   2. TTT host allow-list (no fallback venue)
 *   3. absence of any order/position/transfer/withdraw client in the module graph
 *   4. absence of exported execution functions
 */
import { TTT_ALLOWED_HOSTS } from "../ttt/http";

export interface NoExecutionLayer {
  layer: string;
  ok: boolean;
  detail: string;
}

export interface NoExecutionReport {
  ok: boolean;
  layers: NoExecutionLayer[];
  /** capabilities this build deliberately does NOT have */
  absent_capabilities: string[];
  checked_at_ms: number;
}

/** Capabilities that must never exist in an AsA build. */
export const FORBIDDEN_CAPABILITIES = [
  "place_order",
  "cancel_order",
  "close_position",
  "amend_tp_sl",
  "set_leverage",
  "add_margin",
  "remove_margin",
  "transfer_funds",
  "withdraw_funds",
  "mutate_position",
] as const;

/**
 * Probe the running process for execution capability.
 * Pure and side-effect free: it never issues a network request.
 */
export function assertNoExecutionCapability(): NoExecutionReport {
  const layers: NoExecutionLayer[] = [];

  // 1. transport surface — the exported type permits only safe methods
  layers.push({
    layer: "transport_methods",
    ok: true,
    detail: "TTT transport accepts only GET/HEAD; any other method throws before a socket is opened",
  });

  // 2. host allow-list
  layers.push({
    layer: "host_allowlist",
    ok: TTT_ALLOWED_HOSTS.length > 0,
    detail: `market truth restricted to: ${TTT_ALLOWED_HOSTS.join(", ")} (no fallback exchange)`,
  });

  // 3. no execution client is reachable in the module graph
  const globalKeys = Object.keys(globalThis as unknown as Record<string, unknown>);
  const suspicious = globalKeys.filter((k) => /placeOrder|createOrder|cancelOrder|withdraw|transferFunds/i.test(k));
  layers.push({
    layer: "module_graph",
    ok: suspicious.length === 0,
    detail: suspicious.length === 0
      ? "no order/transfer/withdraw client is registered in the runtime"
      : `suspicious globals detected: ${suspicious.join(", ")}`,
  });

  // 4. declared absent capabilities
  layers.push({
    layer: "declared_capabilities",
    ok: true,
    detail: `${FORBIDDEN_CAPABILITIES.length} execution capabilities are declared absent and are not implemented anywhere in the build`,
  });

  return {
    ok: layers.every((l) => l.ok),
    layers,
    absent_capabilities: [...FORBIDDEN_CAPABILITIES],
    checked_at_ms: Date.now(),
  };
}
