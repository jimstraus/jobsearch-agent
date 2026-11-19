// One sub-agent (facet) per company board. It owns the board's "already seen" memory in
// its own SQLite, so each posting is fetched-and-judged once, no matter how often we scan.

import { Agent } from "agents";
import { fetchBoard, type Ats, type Job } from "./ats";
import { passesTitleFilter, scoreJob, type Prefs, type Score } from "./scoring";

export type ScanInput = {
  company: string;
  ats: Ats;
  slug: string;
  resume: string;
  prefs: Prefs;
};

export type ScoredJob = Job & Score & { ats: Ats };

export type ScanResult = {
  company: string;
  fetched: number;
  newPostings: number;
  scored: number;
  deferred: number; // title-matching postings left for the next scan (per-scan cap)
  results: ScoredJob[];
  error?: string;
};

// Bounds LLM spend per board per scan; the remainder is picked up on the next run.
const MAX_SCORED_PER_SCAN = 25;
const SCORING_CONCURRENCY = 4;

export class BoardScanAgent extends Agent<Env> {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS seen (
      external_id TEXT PRIMARY KEY,
      title TEXT,
      first_seen TEXT
    )`;
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    const { company, ats, slug, resume, prefs } = input;
    const base = {
      company,
      fetched: 0,
      newPostings: 0,
      scored: 0,
      deferred: 0,
      results: []
    };

    let jobs: Job[] | null;
    try {
      jobs = await this.retry(() => fetchBoard(ats, slug, company), {
        maxAttempts: 3
      });
    } catch (error) {
      return { ...base, error: String(error) };
    }
    if (!jobs)
      return { ...base, error: `No ${ats} board found for slug "${slug}"` };

    const seen = new Set(
      this.sql<{ external_id: string }>`SELECT external_id FROM seen`.map(
        (r) => r.external_id
      )
    );
    const fresh = jobs.filter((j) => !seen.has(j.externalId));
    const now = new Date().toISOString();
    const markSeen = (j: Job) =>
      this.sql`INSERT OR IGNORE INTO seen (external_id, title, first_seen)
               VALUES (${j.externalId}, ${j.title}, ${now})`;

    // Postings that fail the title filter are settled immediately — no LLM call needed.
    const candidates: Job[] = [];
    for (const j of fresh) {
      if (passesTitleFilter(j.title, prefs)) candidates.push(j);
      else markSeen(j);
    }

    const batch = candidates.slice(0, MAX_SCORED_PER_SCAN);
    const results: ScoredJob[] = [];
    for (let i = 0; i < batch.length; i += SCORING_CONCURRENCY) {
      const chunk = batch.slice(i, i + SCORING_CONCURRENCY);
      const scored = await Promise.allSettled(
        chunk.map((j) => scoreJob(this.env, resume, prefs, j))
      );
      scored.forEach((s, k) => {
        const job = chunk[k];
        if (s.status === "fulfilled") {
          results.push({ ...job, ...s.value, ats });
          markSeen(job);
        } else {
          // Left unseen so the next scan retries it.
          console.warn(
            `Scoring failed for ${company} / ${job.title}: ${s.reason}`
          );
        }
      });
    }

    return {
      company,
      fetched: jobs.length,
      newPostings: fresh.length,
      scored: results.length,
      deferred: candidates.length - batch.length,
      results
    };
  }

  /** Forget what this board has seen, so the next scan re-judges every posting. */
  async reset(): Promise<void> {
    this.sql`DELETE FROM seen`;
  }
}
