import { createAnthropic } from "@ai-sdk/anthropic";
import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { ATS_LIST, detectBoard, fetchBoard, guessSlug, type Ats } from "./ats";
import {
  BoardScanAgent,
  type ScanResult,
  type ScoredJob
} from "./board-scan-agent";
import {
  anthropicBaseURL,
  DEFAULT_PREFS,
  type Fit,
  type Prefs
} from "./scoring";

export { BoardScanAgent };

export const LEAD_STATUSES = [
  "New",
  "Interested",
  "Applied",
  "Passed",
  "Filtered",
  "Closed"
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type Lead = {
  id: number;
  company: string;
  title: string;
  location: string;
  workplace: string;
  salary: string;
  url: string;
  ats: string;
  posted_at: string;
  found_at: string;
  fit: Fit;
  location_ok: number;
  rationale: string;
  model: string;
  status: LeadStatus;
  note: string;
  updated_at: string;
};

export type WatchItem = { company: string; ats: Ats; slug: string };

export type RunSummary = {
  startedAt: string;
  finishedAt: string;
  trigger: string;
  companies: number;
  fetched: number;
  newPostings: number;
  scored: number;
  leadsAdded: number;
  errors: string[];
};

export type JobSearchState = {
  scanning: boolean;
  hasResume: boolean;
  watchlist: WatchItem[];
  counts: Partial<Record<LeadStatus, number>>;
  lastRun: RunSummary | null;
  leadsVersion: number; // bumped whenever leads change, so the UI knows to refetch
};

export type LeadFilter = {
  status?: LeadStatus;
  fit?: Fit;
  company?: string;
  sinceDays?: number;
  limit?: number;
};

const SCAN_INTERVAL_SECONDS = 6 * 60 * 60;
const BOARD_CONCURRENCY = 3;
const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class JobSearchAgent extends AIChatAgent<Env, JobSearchState> {
  maxPersistedMessages = 200;
  chatRecovery = true;

  initialState: JobSearchState = {
    scanning: false,
    hasResume: false,
    watchlist: [],
    counts: {},
    lastRun: null,
    leadsVersion: 0
  };

  async onStart() {
    this
      .sql`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS watchlist (
      ats TEXT NOT NULL,
      slug TEXT NOT NULL,
      company TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (ats, slug)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      workplace TEXT,
      salary TEXT,
      url TEXT NOT NULL UNIQUE,
      ats TEXT,
      posted_at TEXT,
      found_at TEXT NOT NULL,
      fit TEXT NOT NULL,
      location_ok INTEGER NOT NULL,
      rationale TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'New',
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      summary TEXT NOT NULL
    )`;

    // A crash mid-scan would otherwise leave the flag stuck on.
    if (this.state.scanning) this.setState({ ...this.state, scanning: false });

    // Idempotent: safe on every wake.
    await this.scheduleEvery(SCAN_INTERVAL_SECONDS, "scheduledScan");
  }

  // ── Stored settings ────────────────────────────────────────────────

  private getKv(key: string): string | null {
    return (
      this.sql<{ value: string }>`SELECT value FROM kv WHERE key = ${key}`[0]
        ?.value ?? null
    );
  }

  private setKv(key: string, value: string) {
    this.sql`INSERT INTO kv (key, value) VALUES (${key}, ${value})
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  private getResume(): string | null {
    return this.getKv("resume");
  }

  private getPrefs(): Prefs {
    const raw = this.getKv("prefs");
    return raw
      ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
      : DEFAULT_PREFS;
  }

  private getWatchlist(): WatchItem[] {
    return this
      .sql<WatchItem>`SELECT company, ats, slug FROM watchlist ORDER BY company`;
  }

  private refreshState(patch: Partial<JobSearchState> = {}) {
    const counts: Partial<Record<LeadStatus, number>> = {};
    for (const r of this.sql<{ status: LeadStatus; n: number }>`
      SELECT status, COUNT(*) AS n FROM leads GROUP BY status`) {
      counts[r.status] = r.n;
    }
    this.setState({
      ...this.state,
      hasResume: this.getResume() !== null,
      watchlist: this.getWatchlist(),
      counts,
      ...patch
    });
  }

  // ── Operations shared by chat tools and the UI ─────────────────────

  @callable()
  saveResume(text: string): { ok: true; characters: number } {
    const trimmed = text.trim();
    if (trimmed.length < 200)
      throw new Error("That looks too short to be a full résumé.");
    this.setKv("resume", trimmed);
    this.refreshState();
    return { ok: true, characters: trimmed.length };
  }

  @callable()
  preferences(): Prefs {
    return this.getPrefs();
  }

  @callable()
  updatePreferences(patch: Partial<Prefs>): Prefs {
    const next = { ...this.getPrefs(), ...patch };
    this.setKv("prefs", JSON.stringify(next));
    return next;
  }

  @callable()
  async addCompany(company: string, slug?: string, ats?: Ats) {
    const s = slug?.trim() || guessSlug(company);
    let found: { ats: Ats; count: number } | null;
    if (ats) {
      const jobs = await fetchBoard(ats, s, company);
      found = jobs ? { ats, count: jobs.length } : null;
    } else {
      found = await detectBoard(s, company);
    }
    if (!found) {
      return {
        added: false,
        message: `No public Greenhouse, Lever or Ashby board found for "${s}". Ask the user for the board slug from the company's careers URL (e.g. job-boards.greenhouse.io/<slug>).`
      };
    }
    this.sql`INSERT OR REPLACE INTO watchlist (ats, slug, company, added_at)
             VALUES (${found.ats}, ${s}, ${company}, ${new Date().toISOString()})`;
    this.refreshState();
    return {
      added: true,
      company,
      ats: found.ats,
      slug: s,
      openPostings: found.count
    };
  }

  @callable()
  removeCompany(company: string) {
    const before = this.getWatchlist().length;
    this
      .sql`DELETE FROM watchlist WHERE lower(company) = lower(${company}) OR slug = ${company}`;
    this.refreshState();
    return { removed: before - this.getWatchlist().length };
  }

  @callable()
  listLeads(filter: LeadFilter = {}): Lead[] {
    const since = filter.sinceDays
      ? new Date(Date.now() - filter.sinceDays * 86_400_000).toISOString()
      : "";
    const company = filter.company ? `%${filter.company.toLowerCase()}%` : "";
    const limit = Math.min(filter.limit ?? 50, 200);
    return this.sql<Lead>`
      SELECT * FROM leads
      WHERE (${filter.status ?? ""} = '' OR status = ${filter.status ?? ""})
        AND (${filter.fit ?? ""} = '' OR fit = ${filter.fit ?? ""})
        AND (${company} = '' OR lower(company) LIKE ${company})
        AND found_at >= ${since}
      ORDER BY CASE fit WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 WHEN 'Low' THEN 2 ELSE 3 END,
               found_at DESC
      LIMIT ${limit}`;
  }

  @callable()
  triageLeads(ids: number[], status: LeadStatus, note?: string) {
    if (!LEAD_STATUSES.includes(status))
      throw new Error(`Unknown status ${status}`);
    const now = new Date().toISOString();
    for (const id of ids) {
      if (note !== undefined) {
        this
          .sql`UPDATE leads SET status = ${status}, note = ${note}, updated_at = ${now} WHERE id = ${id}`;
      } else {
        this
          .sql`UPDATE leads SET status = ${status}, updated_at = ${now} WHERE id = ${id}`;
      }
    }
    this.refreshState({ leadsVersion: this.state.leadsVersion + 1 });
    return { updated: ids.length, status };
  }

  @callable()
  recentRuns(limit = 5): RunSummary[] {
    return this.sql<{ summary: string }>`
      SELECT summary FROM runs ORDER BY id DESC LIMIT ${limit}`.map(
      (r) => JSON.parse(r.summary) as RunSummary
    );
  }

  // ── Scanning: fan out one sub-agent per board ──────────────────────

  async scheduledScan() {
    if (!this.getResume() || this.getWatchlist().length === 0) return;
    await this.runScan("schedule");
  }

  @callable()
  async scanNow(): Promise<RunSummary> {
    return this.runScan("manual");
  }

  /** Scan one company now. Uses the watchlist entry if there is one, otherwise probes for a board. */
  @callable()
  async scanCompany(
    company: string,
    slug?: string
  ): Promise<RunSummary | { error: string }> {
    const known = this.getWatchlist().find(
      (w) =>
        w.company.toLowerCase() === company.toLowerCase() || w.slug === slug
    );
    let target: WatchItem | undefined = known;
    if (!target) {
      const s = slug?.trim() || guessSlug(company);
      const found = await detectBoard(s, company);
      if (!found)
        return {
          error: `No public Greenhouse, Lever or Ashby board found for "${s}".`
        };
      target = { company, ats: found.ats, slug: s };
    }
    return this.runScan(`company:${company}`, [target]);
  }

  private async runScan(
    trigger: string,
    targets?: WatchItem[]
  ): Promise<RunSummary> {
    const resume = this.getResume();
    if (!resume) throw new Error("Upload a résumé before scanning.");
    if (this.state.scanning) throw new Error("A scan is already running.");
    const boards = targets ?? this.getWatchlist();
    const prefs = this.getPrefs();
    const startedAt = new Date().toISOString();
    this.setState({ ...this.state, scanning: true });

    const results: ScanResult[] = [];
    try {
      for (let i = 0; i < boards.length; i += BOARD_CONCURRENCY) {
        const chunk = boards.slice(i, i + BOARD_CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map(async (b) => {
            const child = await this.subAgent(
              BoardScanAgent,
              `${b.ats}:${b.slug}`
            );
            return child.scan({
              company: b.company,
              ats: b.ats,
              slug: b.slug,
              resume,
              prefs
            });
          })
        );
        settled.forEach((s, k) =>
          results.push(
            s.status === "fulfilled"
              ? s.value
              : {
                  company: chunk[k].company,
                  fetched: 0,
                  newPostings: 0,
                  scored: 0,
                  deferred: 0,
                  results: [],
                  error: String(s.reason)
                }
          )
        );
      }
    } finally {
      this.setState({ ...this.state, scanning: false });
    }

    const leadsAdded = results.reduce(
      (n, r) => n + this.storeLeads(r.results),
      0
    );
    const summary: RunSummary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      trigger,
      companies: boards.length,
      fetched: results.reduce((n, r) => n + r.fetched, 0),
      newPostings: results.reduce((n, r) => n + r.newPostings, 0),
      scored: results.reduce((n, r) => n + r.scored, 0),
      leadsAdded,
      errors: results
        .filter((r) => r.error)
        .map((r) => `${r.company}: ${r.error}`)
    };
    this
      .sql`INSERT INTO runs (started_at, summary) VALUES (${startedAt}, ${JSON.stringify(summary)})`;
    this.refreshState({
      lastRun: summary,
      leadsVersion: this.state.leadsVersion + 1
    });
    return summary;
  }

  /** Insert scored postings. Good fits land as New; the rest are kept as Filtered so nothing is lost. */
  private storeLeads(jobs: ScoredJob[]): number {
    const now = new Date().toISOString();
    let added = 0;
    for (const j of jobs) {
      const keep = j.location_ok && (j.fit === "High" || j.fit === "Medium");
      const status: LeadStatus = keep ? "New" : "Filtered";
      const rows = this.sql<{ id: number }>`
        INSERT OR IGNORE INTO leads
          (company, title, location, workplace, salary, url, ats, posted_at, found_at,
           fit, location_ok, rationale, model, status, updated_at)
        VALUES (${j.company}, ${j.title}, ${j.location}, ${j.workplace}, ${j.salary}, ${j.url},
                ${j.ats}, ${j.postedAt}, ${now}, ${j.fit}, ${j.location_ok ? 1 : 0},
                ${j.rationale}, ${j.model}, ${status}, ${now})
        RETURNING id`;
      if (rows.length && keep) added++;
    }
    return added;
  }

  // ── Chat ───────────────────────────────────────────────────────────

  private chatModel() {
    if (this.env.ANTHROPIC_API_KEY) {
      const gateway = anthropicBaseURL(this.env);
      const anthropic = createAnthropic({
        apiKey: this.env.ANTHROPIC_API_KEY,
        baseURL: gateway ? `${gateway}/v1` : undefined
      });
      return anthropic(this.env.CHAT_MODEL || "claude-opus-5-5");
    }
    return createWorkersAI({ binding: this.env.AI })(LLAMA);
  }

  private chatSystemPrompt(): string {
    const s = this.state;
    const watch =
      s.watchlist.map((w) => `${w.company} (${w.ats}:${w.slug})`).join(", ") ||
      "none yet";
    return `You are the user's job-search agent. Every 6 hours you scan the job boards of the companies on their watchlist, using one sub-agent per board, and score each new posting against their résumé. Good fits land as leads with status New; the rest are stored as Filtered.

Through the tools you can: save their résumé, view and change their search preferences, add or remove watchlist companies, scan now (everything, or one company on demand, even if it isn't on the watchlist), list leads, and triage leads (Interested, Applied, Passed, Closed).

Current state:
- Résumé on file: ${s.hasResume ? "yes" : "NO — ask the user to paste it or use the Résumé button before scanning"}
- Watchlist: ${watch}
- Lead counts: ${JSON.stringify(s.counts)}
- Last scan: ${s.lastRun ? `${s.lastRun.finishedAt} (${s.lastRun.leadsAdded} new leads)` : "never"}
- Today: ${new Date().toISOString().slice(0, 10)}

When you list leads, show a compact table: id, company, title, fit, location, and a link. Refer to leads by id when triaging. If the user pastes their résumé text, save it with saveResume. Be concise.`;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const result = streamText({
      model: this.chatModel(),
      system: this.chatSystemPrompt(),
      // History is left unedited: Claude's thinking blocks are only valid in the
      // conversation that produced them, so pruning would invalidate them.
      messages: await convertToModelMessages(this.messages),
      providerOptions: { anthropic: { effort: "low" } },
      tools: {
        saveResume: tool({
          description:
            "Save the user's master résumé (plain text or markdown). Replaces any previous one.",
          inputSchema: z.object({
            text: z.string().describe("The full résumé text")
          }),
          execute: async ({ text }) => this.saveResume(text)
        }),
        getPreferences: tool({
          description:
            "Show the current search preferences (title keywords, location rule, leveling notes).",
          inputSchema: z.object({}),
          execute: async () => this.getPrefs()
        }),
        updatePreferences: tool({
          description:
            "Change search preferences. Pass only the fields to change; keyword lists replace the old list entirely.",
          inputSchema: z.object({
            titleInclude: z.array(z.string()).optional(),
            titleExclude: z.array(z.string()).optional(),
            locationRule: z.string().optional(),
            notes: z.string().optional()
          }),
          execute: async (patch) => this.updatePreferences(patch)
        }),
        addCompany: tool({
          description:
            "Add a company to the watchlist. The board is auto-detected from the slug (default: the company name squashed to lowercase).",
          inputSchema: z.object({
            company: z.string(),
            slug: z.string().optional().describe("ATS board slug, if known"),
            ats: z.enum(ATS_LIST as [Ats, ...Ats[]]).optional()
          }),
          execute: async ({ company, slug, ats }) =>
            this.addCompany(company, slug, ats)
        }),
        removeCompany: tool({
          description: "Remove a company from the watchlist by name or slug.",
          inputSchema: z.object({ company: z.string() }),
          execute: async ({ company }) => this.removeCompany(company)
        }),
        listWatchlist: tool({
          description: "List the companies on the watchlist.",
          inputSchema: z.object({}),
          execute: async () => this.getWatchlist()
        }),
        scanNow: tool({
          description:
            "Scan now. With a company, scans just that company (company-scan), even if it isn't on the watchlist. Without one, scans the whole watchlist. Can take a minute or more.",
          inputSchema: z.object({
            company: z.string().optional(),
            slug: z.string().optional()
          }),
          execute: async ({ company, slug }) => {
            try {
              return company
                ? await this.scanCompany(company, slug)
                : await this.scanNow();
            } catch (error) {
              return { error: String(error) };
            }
          }
        }),
        listLeads: tool({
          description:
            "List leads, best fit first. Filter by status, fit, company, or recency.",
          inputSchema: z.object({
            status: z.enum(LEAD_STATUSES).optional(),
            fit: z.enum(["High", "Medium", "Low", "Reject"]).optional(),
            company: z.string().optional(),
            sinceDays: z.number().optional(),
            limit: z.number().optional()
          }),
          execute: async (filter) =>
            this.listLeads(filter).map(
              ({
                id,
                company,
                title,
                fit,
                location,
                url,
                status,
                rationale
              }) => ({
                id,
                company,
                title,
                fit,
                location,
                url,
                status,
                rationale
              })
            )
        }),
        triageLeads: tool({
          description:
            "Set the status of one or more leads by id, with an optional note.",
          inputSchema: z.object({
            ids: z.array(z.number()),
            status: z.enum(LEAD_STATUSES),
            note: z.string().optional()
          }),
          execute: async ({ ids, status, note }) =>
            this.triageLeads(ids, status, note)
        }),
        scanHistory: tool({
          description: "Summaries of the most recent scans.",
          inputSchema: z.object({}),
          execute: async () => this.recentRuns()
        })
      },
      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

/** Optional shared-secret gate: when APP_TOKEN is set, every agent request must carry ?token=. */
function checkToken(request: Request, env: Env): Response | undefined {
  if (!env.APP_TOKEN) return undefined;
  const token = new URL(request.url).searchParams.get("token");
  return token === env.APP_TOKEN
    ? undefined
    : new Response("Unauthorized", { status: 401 });
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env, {
        onBeforeConnect: (req) => checkToken(req, env),
        onBeforeRequest: (req) => checkToken(req, env)
      })) || new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
