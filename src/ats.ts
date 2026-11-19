// Public job-board APIs for the three ATSes JobFinder found most reliable.
// No scraping, no auth — each returns JSON for a company's whole board.

export type Ats = "greenhouse" | "lever" | "ashby";
export const ATS_LIST: Ats[] = ["greenhouse", "lever", "ashby"];

export type Job = {
  externalId: string;
  company: string;
  title: string;
  location: string;
  workplace: string; // "remote" | "hybrid" | "onsite" | "" (as reported by the ATS)
  url: string;
  postedAt: string; // ISO date or ""
  salary: string;
  description: string; // plain text
};

const UA = {
  "user-agent": "jobsearch-agent (+https://developers.cloudflare.com/agents/)"
};

function htmlToText(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<(br|\/p|\/li|\/h\d|\/div)>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getJson(url: string): Promise<unknown | null> {
  const res = await fetch(url, { headers: UA });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  offices?: { name?: string }[];
  first_published?: string;
  updated_at?: string;
  content?: string;
};

type LeverJob = {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string; allLocations?: string[] };
  workplaceType?: string;
  createdAt?: number;
  salaryRange?: { min?: number; max?: number; currency?: string } | null;
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
};

type AshbyJob = {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl: string;
  publishedAt?: string;
  isListed?: boolean;
  descriptionPlain?: string;
  compensation?: { compensationTierSummary?: string };
};

/** Fetch every open posting on a company's board. Returns null if the board doesn't exist. */
export async function fetchBoard(
  ats: Ats,
  slug: string,
  company: string
): Promise<Job[] | null> {
  const s = encodeURIComponent(slug);
  switch (ats) {
    case "greenhouse": {
      const data = (await getJson(
        `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`
      )) as { jobs: GreenhouseJob[] } | null;
      if (!data) return null;
      return data.jobs.map((j) => ({
        externalId: String(j.id),
        company,
        title: j.title.trim(),
        // Many boards put "Hybrid"/"Remote" in location and the real cities in offices.
        location: [j.location?.name, ...(j.offices ?? []).map((o) => o.name)]
          .filter((v, i, a): v is string => !!v && a.indexOf(v) === i)
          .join("; "),
        workplace: /remote|hybrid|office|distributed/i.test(
          j.location?.name ?? ""
        )
          ? (j.location?.name ?? "").toLowerCase()
          : "",
        url: j.absolute_url,
        postedAt: j.first_published ?? j.updated_at ?? "",
        salary: "",
        description: htmlToText(j.content ?? "")
      }));
    }
    case "lever": {
      const data = (await getJson(
        `https://api.lever.co/v0/postings/${s}?mode=json`
      )) as LeverJob[] | { ok: false } | null;
      if (!data || !Array.isArray(data)) return null;
      return data.map((j) => ({
        externalId: j.id,
        company,
        title: j.text.trim(),
        location: (
          j.categories?.allLocations ?? [j.categories?.location ?? ""]
        ).join("; "),
        workplace: j.workplaceType ?? "",
        url: j.hostedUrl,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : "",
        salary: j.salaryRange?.min
          ? `${j.salaryRange.currency ?? ""} ${j.salaryRange.min}–${j.salaryRange.max ?? ""}`.trim()
          : "",
        description: [
          j.descriptionPlain ?? "",
          ...(j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`),
          j.additionalPlain ?? ""
        ].join("\n\n")
      }));
    }
    case "ashby": {
      const data = (await getJson(
        `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`
      )) as { jobs: AshbyJob[] } | null;
      if (!data) return null;
      return data.jobs
        .filter((j) => j.isListed !== false)
        .map((j) => ({
          externalId: j.id,
          company,
          title: j.title.trim(),
          location: [
            j.location ?? "",
            ...(j.secondaryLocations ?? []).map((l) => l.location)
          ]
            .filter(Boolean)
            .join("; "),
          workplace: j.isRemote
            ? "remote"
            : (j.workplaceType ?? "").toLowerCase(),
          url: j.jobUrl,
          postedAt: j.publishedAt ?? "",
          salary: j.compensation?.compensationTierSummary ?? "",
          description: j.descriptionPlain ?? ""
        }));
    }
  }
}

/** Guess a board slug from a company name ("Close Brothers, Inc." → "closebrothers"). */
export function guessSlug(company: string): string {
  return company
    .toLowerCase()
    .replace(/,?\s+(inc|llc|ltd|corp|co)\.?$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Find which ATS hosts a company's board by probing every public API. Companies that
 * migrated ATSes often leave a stale board behind, so the busiest board wins.
 */
export async function detectBoard(
  slug: string,
  company: string
): Promise<{ ats: Ats; count: number } | null> {
  const probes = await Promise.allSettled(
    ATS_LIST.map((ats) => fetchBoard(ats, slug, company))
  );
  let best: { ats: Ats; count: number } | null = null;
  probes.forEach((p, i) => {
    if (
      p.status === "fulfilled" &&
      p.value &&
      (!best || p.value.length > best.count)
    ) {
      best = { ats: ATS_LIST[i], count: p.value.length };
    }
  });
  return best;
}
