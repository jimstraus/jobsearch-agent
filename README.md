# JobSearch Agent

An AI job-search agent on Cloudflare. Every 6 hours it wakes up, sends one **sub-agent per
company job board** to fetch new postings, scores each against your résumé with an LLM, and keeps
everything in **Durable Object SQLite**. You talk to it in a **chat UI**: add companies, ask what
came in, scan a company on demand, and triage leads.

It's a Cloudflare-native port of the discovery + triage half of
[JobFinder](https://github.com/jimstraus/JobFinder), a set of Claude Code skills. The Google Sheet is
replaced by SQL, and the Sheet's checkbox workflow is replaced by chat and the leads panel.

## How it maps to the assignment

| Requirement | Implementation |
|---|---|
| **LLM** | Claude (`claude-opus-5-5`) for chat and fit-scoring, with **Workers AI Llama 3.3** (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) as the automatic fallback. Optionally routed through **AI Gateway**. |
| **Workflow / coordination** | `JobSearchAgent` (Agents SDK, Durable Object) schedules itself with `scheduleEvery(6h)` and fans out to `BoardScanAgent` **sub-agents** (facets), one per board, 3 at a time. |
| **User input via chat** | React chat UI (`useAgentChat`) served as Worker static assets, plus a leads panel that triages over `@callable` RPC. |
| **Memory / state** | Parent SQLite: résumé, preferences, watchlist, leads, run history. Each sub-agent's own SQLite: which postings that board has already seen, so a posting is only judged once. Chat history persists through `AIChatAgent`. |

## Architecture

```
 Browser (React chat + leads panel)
        │  WebSocket: chat stream, state sync, @callable RPC
        ▼
 JobSearchAgent  (Durable Object, AIChatAgent)          ── Claude via AI SDK (chat tools)
   SQLite: kv(résumé, prefs) · watchlist · leads · runs
   scheduleEvery(6h) → runScan()
        │  this.subAgent(BoardScanAgent, "<ats>:<slug>")   (fan-out, 3 concurrent)
        ▼
 BoardScanAgent × N  (facets with their own SQLite: seen postings)
   1. fetch board JSON  (Greenhouse / Lever / Ashby public APIs, retried)
   2. drop already-seen postings
   3. title prefilter (include/exclude keywords, no LLM)
   4. LLM fit score: Claude structured output → fallback Llama 3.3 JSON mode
        │  returns scored postings
        ▼
 JobSearchAgent stores leads: High/Medium + location OK → "New"; everything else → "Filtered"
```

Design notes carried over from JobFinder:
- **Verify on the company's own board.** Only ATS-hosted company boards are scanned, so every lead's
  URL is the employer's own posting, never an aggregator re-post.
- **A "Remote" label alone is not proof.** The location rule is judged by the LLM from the title and
  description, not only the location field.
- **Title-inflation notes** (e.g. Oracle "Principal" ≈ industry Senior) are part of the editable
  preferences and go into every scoring prompt.
- **ATS detection** probes all three ATSes and picks the busiest board, because companies that switched
  ATS often leave a stale board behind.
- **Cost bounds.** The title prefilter discards most postings without an LLM call. At most 25 postings
  per board are scored per scan, and the rest carry over to the next scan. The résumé and rules prefix
  is prompt-cached across a scan.

## Running it

```bash
npm install
cp .dev.vars.example .dev.vars   # add ANTHROPIC_API_KEY (optional: without it, everything runs on Llama 3.3)
npm run dev                      # http://localhost:5173
```

Then, in chat:
1. Paste your résumé, or attach it as a PDF (PDF reading needs Claude).
2. Type "Add Cloudflare to my watchlist". The board is auto-detected; give a slug if the name doesn't match.
3. Click **Scan now**, or say "scan Anthropic now" for a one-off company scan.
4. Triage in the leads panel, or in chat: "mark 12 and 17 as interested".

### Deploy

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APP_TOKEN        # recommended: gates the public URL
npm run deploy
```

Open `https://<worker>.workers.dev/?token=<APP_TOKEN>` once; the browser remembers the token. For
stronger protection, put the Worker behind Cloudflare Access.

### Configuration (`wrangler.jsonc` vars)

| Var | Default | Purpose |
|---|---|---|
| `CHAT_MODEL` | `claude-opus-5-5` | Chat model |
| `SCORE_MODEL` | `claude-opus-5-5` | Fit-scoring model (e.g. `claude-haiku-5-5` for lower cost) |
| `CF_ACCOUNT_ID`, `AI_GATEWAY_ID` | empty | Set both to route Claude through AI Gateway |

## Files

| File | What it does |
|---|---|
| `src/server.ts` | `JobSearchAgent`: SQL schema, schedule, scan orchestration, chat tools, auth gate |
| `src/board-scan-agent.ts` | `BoardScanAgent` sub-agent: fetch → dedupe → prefilter → score one board |
| `src/ats.ts` | Greenhouse / Lever / Ashby API clients and board detection |
| `src/scoring.ts` | Preferences, title prefilter, Claude scoring with Llama fallback |
| `src/app.tsx`, `src/leads-panel.tsx` | Chat UI and leads panel |
| `Prompts.md` | Prompt history for this build (AI-assisted, as the assignment requires) |

Scaffolded from [`cloudflare/agents-starter`](https://github.com/cloudflare/agents-starter) (MIT).
