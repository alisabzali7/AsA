/**
 * Runtime state singleton — safe under Next dev HMR via globalThis.
 * API routes await ensureEngineBooted() so the live pipeline is real.
 */
import { marketEngine } from "./market/engine";

interface GlobalThisWithAsa {
  __asaBootPromise?: Promise<void>;
  __asaBootError?: string;
}

function g(): GlobalThisWithAsa {
  return globalThis as GlobalThisWithAsa;
}

export function ensureEngineBooted(): Promise<void> {
  const gg = g();
  if (gg.__asaBootPromise) return gg.__asaBootPromise;
  const p = marketEngine
    .start()
    .then(() => {
      gg.__asaBootError = undefined;
    })
    .catch((err) => {
      gg.__asaBootError = err instanceof Error ? err.message : String(err);
      gg.__asaBootPromise = undefined; // allow retry on next request
      throw err;
    });
  gg.__asaBootPromise = p;
  return p;
}

export function bootError(): string | null {
  return g().__asaBootError ?? null;
}

export function isBooted(): boolean {
  return marketEngine.isRunning();
}
