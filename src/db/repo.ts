/**
 * Storage repository seam (master §65): business logic depends on the Repo
 * interface, never on SQLite APIs directly. Local default = SQLite.
 * The adapter seam keeps storage swappable: any future backend implements the
 * same interface without touching
 * consumers. All SQL lives in the adapter impl (src/db/sqlite.ts).
 */

export interface OpportunityRow {
  id: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  state: string;
  mode: string;
  strategy_id: string;
  payload_json: string;
  created_ms: number;
  updated_ms: number;
}

export interface SignalRow {
  id: string;
  state: string;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  strategy_id: string;
  opp_id: string | null;
  payload_json: string;
  created_ms: number;
  updated_ms: number;
  /**
   * DELIVERY PROVENANCE (T05 T4): the telegram_outbox row created in the SAME
   * publication transaction as this signal. Stable reference only — the
   * outbox row remains the single source of truth for delivery state
   * (QUEUED/FAILED/SENT/DEAD, attempts, progress); nothing is copied here.
   * NULL = published before this column existed (legacy) or never published.
   */
  outbox_id?: number | null;
}

export interface JournalRow {
  id: number;
  created_ms: number;
  updated_ms: number;
  symbol: string;
  direction: string;
  notes: string;
  opp_id: string | null;
  r_multiple: number | null;
}

export interface OutboxRow {
  id: number;
  kind: string;
  payload_json: string;
  state: "QUEUED" | "SENT" | "FAILED" | "DEAD";
  /**
   * HONEST SEMANTICS (T05 T3): counts logical delivery attempts that ENTERED
   * THE TRANSPORT PHASE (a Telegram provider request was made or attempted),
   * exactly once per delivery cycle. Preflight failures (not configured,
   * dry-run), claim failures and parse failures happen before any provider
   * request and MUST NOT increment it — the retry budget is only ever spent
   * by real delivery attempts.
   */
  attempts: number;
  error: string | null;
  created_ms: number;
  sent_ms: number | null;
  /** current delivery-cycle owner (T05 T3); NULL = unclaimed */
  claimed_by: string | null;
  claim_ms: number | null;
  /** lease deadline; a row is "sending" only while claimed_by is set AND now < claim_expires_ms */
  claim_expires_ms: number | null;
}

/**
 * Ownership token for one delivery cycle of an outbox row (T05 T3).
 *
 * The claim/lease lives in the PERSISTENCE layer (columns on the row), so it
 * serializes consumers across processes and across overlapping drains — not
 * merely within one JS event loop. All transport-phase writes are conditioned
 * on the exact claim identity: a stale worker whose lease was reclaimed can
 * never overwrite the new owner's row.
 */
export interface OutboxClaim {
  /** unique token of THIS delivery cycle (worker identity for the row) */
  token: string;
  /** when this consumer took ownership */
  claimed_at_ms: number;
  /**
   * persisted lease deadline (claimed_at_ms + lease). Ownership is valid only
   * until this instant; afterwards any consumer may reclaim the row. The
   * lease travels WITH the claim so a crashed worker's short lease can expire
   * on schedule while normal workers keep the production lease.
   */
  expires_at_ms: number;
}

/** Retry budget: logical TRANSPORT attempts per outbox row. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/**
 * Claim lease: how long one consumer owns a row before another may reclaim
 * it. Covers the worst-case single cycle (30s photo + 15s text timeouts) plus
 * chart rendering / queue headroom. A crashed worker's row is reclaimable
 * after this window — never permanently stranded. Tests may construct claims
 * with shorter leases to exercise expiry deterministically.
 */
export const OUTBOX_CLAIM_LEASE_MS = 120_000;

export interface AiCallRow {
  id: number;
  created_ms: number;
  provider: string;
  model: string;
  latency_ms: number | null;
  verdict: string;
  structured_json: string;
  error: string | null;
}

export interface NewsRow {
  id: number;
  dedupe_key: string;
  source: string;
  source_type: string;
  url: string;
  title: string;
  summary: string;
  impact: string;
  symbols_json: string;
  published_ms: number | null;
  ingested_ms: number;
}

export interface RetentionRunRow {
  id: number;
  ran_ms: number;
  table_name: string;
  deleted: number;
  cutoff_ms: number;
  ok: number;
  note: string;
}

export interface BacktestJobRow {
  id: string;
  created_ms: number;
  status: string;
  symbol: string;
  timeframe: string;
  strategy_id: string;
  params_json: string;
  result_json: string | null;
  error: string | null;
}

export interface Repo {
  configGet(k: string): string | null;
  configSet(k: string, v: string): void;
  opportunityUpsert(o: OpportunityRow): void;
  opportunityList(limit: number): OpportunityRow[];
  opportunityGet(id: string): OpportunityRow | null;
  opportunityCount(): number;
  signalInsert(s: SignalRow): void;
  signalUpdate(s: Partial<SignalRow> & { id: string }): void;
  signalList(limit: number): SignalRow[];
  signalPage(limit: number, offset: number): SignalRow[];
  signalByOpp(oppId: string): SignalRow | null;
  signalGet(id: string): SignalRow | null;
  journalAdd(j: Omit<JournalRow, "id">): number;
  journalList(): JournalRow[];
  journalDelete(id: number): void;
  outboxEnqueue(kind: string, payload: unknown): number;
  outboxList(state: OutboxRow["state"] | "ALL", limit: number): OutboxRow[];
  /** AUDIT FIX (P1): rows eligible for a retry — QUEUED plus FAILED rows that have not exhausted their TRANSPORT attempts. DEAD is terminal. A live (unexpired) claim does not make a row retryable for anyone else — `outboxClaim` is the arbiter. */
  outboxRetryable(limit: number): OutboxRow[];
  /** One outbox row by its stable id (delivery provenance lookups). */
  outboxGet(id: number): OutboxRow | null;
  /**
   * Fallback provenance for LEGACY signals published before `signals.outbox_id`
   * existed: the outbox row whose payload names this opportunity (oldest first).
   */
  outboxForOpportunity(oppId: string): OutboxRow | null;
  /**
   * ATOMICALLY claim a retryable row for one delivery cycle (T05 T3).
   * Succeeds only if the row is QUEUED/FAILED, within the retry budget, and
   * either unclaimed or its persisted lease has expired (crash recovery). The
   * winner is recorded as claimed_by/claim_ms/claim_expires_ms; every
   * transport-phase write must then present this exact claim. Returns false
   * when another active consumer owns the row (caller must NOT send anything).
   */
  outboxClaim(id: number, claim: OutboxClaim): boolean;
  /**
   * Record that this delivery cycle entered the transport phase — THE only
   * place `attempts` increments (exactly once per cycle). Returns the new
   * attempts count, or null when the claim is no longer held (stale owner).
   */
  outboxCountAttempt(id: number, claim: OutboxClaim): number | null;
  /**
   * Write the outcome state/error for a row. With `claim`, the write only
   * applies while that exact claim is still the owner (stale owners cannot
   * corrupt a reclaimed row) and the claim is released. WITHOUT `claim` this
   * is an unconditional note write (preflight paths). NEVER touches attempts.
   */
  outboxMark(id: number, state: OutboxRow["state"], error?: string | null, claim?: OutboxClaim | null): boolean;
  /**
   * Persist an updated payload for an outbox row (e.g. delivery sub-step
   * progress). With `claim`, only while that exact claim is still the owner.
   * The row id — the stable logical delivery identity — never changes.
   */
  outboxSetPayload(id: number, payload_json: string, claim?: OutboxClaim | null): boolean;
  /** Run several writes atomically (all-or-nothing). Used where a multi-row invariant must hold across crashes (e.g. signal publish = signal row + outbox row as ONE act). */
  withTransaction<T>(fn: () => T): T;
  aiCallInsert(c: Omit<AiCallRow, "id">): void;
  aiCallList(limit: number): AiCallRow[];
  newsUpsert(n: Omit<NewsRow, "id">): { inserted: boolean };
  newsList(opts: { days: number; limit: number }): NewsRow[];
  newsDeleteOlderThan(cutoffMs: number): number;
  retentionLog(r: Omit<RetentionRunRow, "id">): void;
  retentionRuns(limit: number): RetentionRunRow[];
  backtestCreate(j: BacktestJobRow): void;
  backtestUpdate(id: string, status: string, resultJson: string | null, error: string | null): void;
  backtestGet(id: string): BacktestJobRow | null;
  backtestList(limit: number): BacktestJobRow[];
  close(): void;
}
