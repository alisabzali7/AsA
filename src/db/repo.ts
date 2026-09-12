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
  attempts: number;
  error: string | null;
  created_ms: number;
  sent_ms: number | null;
}

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
  journalAdd(j: Omit<JournalRow, "id">): number;
  journalList(): JournalRow[];
  journalDelete(id: number): void;
  outboxEnqueue(kind: string, payload: unknown): number;
  outboxList(state: OutboxRow["state"] | "ALL", limit: number): OutboxRow[];
  /** AUDIT FIX (P1): rows eligible for a retry — QUEUED plus FAILED rows that have not exhausted their attempts. DEAD is terminal. */
  outboxRetryable(limit: number): OutboxRow[];
  outboxMark(id: number, state: OutboxRow["state"], error?: string | null): void;
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
