# Local (Windows-first) Deployment

Requirements: Node 20+, optional Ollama. Storage is embedded SQLite via
`better-sqlite3` — no database server to provision.

1. `npm ci`
2. `copy .env.example .env` and set the TTT/AI/Telegram values you need
3. Build runtime state from the source corpus (SQLite files are created
   automatically under `asa-data/`; they are NOT shipped):
   - `npm run brain:ingest`  → `brain.db` (9,398 fragments)
   - `npm run brain:mine`    → knowledge atoms / components / candidates
4. `npm run build && npm run start` (or `npm run dev`)
5. Open http://localhost:3000 — backend boots the engine; first backfill takes a few minutes within the TTT budget.
6. Warm durable market history on demand (walks to the TTT venue boundary):
   `curl "http://localhost:3000/api/market/history?symbol=BTCUSDT&tf=1h&sync=full&limit=1"`

Windows taskbar-free autostart (optional): create a `run-asa.bat` with:
```
cd /d C:\asa
npm run build && npm run start
```
and schedule it via Task Scheduler (trigger: on logon).

Ollama (optional): install Ollama, `ollama pull qwen2.5:3b`, set `OLLAMA_URL=http://127.0.0.1:11434`, choose provider `auto` or `ollama` in Settings → AI. AsA probes health every status poll and labels everything honestly.
