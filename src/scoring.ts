// Fit scoring: a cheap deterministic title prefilter, then an LLM judgment against the
// user's résumé + rules. Claude does the judging; Workers AI Llama 3.3 is the fallback
// when Claude is unavailable (no key, outage, rate limit).

import Anthropic from "@anthropic-ai/sdk";
import type { Job } from "./ats";

export type Prefs = {
  titleInclude: string[]; // a title must contain one of these…
  titleExclude: string[]; // …and none of these
  locationRule: string; // natural language, judged by the LLM
  notes: string; // leveling notes, e.g. title-inflation translations
};

export const DEFAULT_PREFS: Prefs = {
  titleInclude: ["principal", "staff", "architect", "distinguished"],
  titleExclude: [
    "manager",
    "director",
    "account executive",
    "sales",
    "marketing",
    "recruit",
    "intern",
    "designer",
    "counsel",
    "finance"
  ],
  locationRule:
    "Fully remote within the US, or on-site/hybrid in the Austin, TX metro. A 'Remote' label alone is not proof — if the title or description ties the role to another city, it fails.",
  notes:
    "Oracle titles run one level high: Oracle 'Principal' ≈ industry Senior, so down-level Oracle roles before judging fit."
};

export type Fit = "High" | "Medium" | "Low" | "Reject";

export type Score = {
  fit: Fit;
  location_ok: boolean;
  rationale: string;
  model: string;
};

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    fit: { type: "string", enum: ["High", "Medium", "Low", "Reject"] },
    location_ok: { type: "boolean" },
    rationale: {
      type: "string",
      description: "One sentence, under 200 characters."
    }
  },
  required: ["fit", "location_ok", "rationale"],
  additionalProperties: false
} as const;

const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// Llama 3.3 on Workers AI has a ~24k-token window; keep its job text well inside that.
const LLAMA_MAX_DESCRIPTION_CHARS = 12_000;

export function passesTitleFilter(title: string, prefs: Prefs): boolean {
  const t = title.toLowerCase();
  return (
    prefs.titleInclude.some((k) => t.includes(k.toLowerCase())) &&
    !prefs.titleExclude.some((k) => t.includes(k.toLowerCase()))
  );
}

function systemPrompt(resume: string, prefs: Prefs): string {
  return `You screen job postings for one candidate and decide how well each fits them.

<resume>
${resume}
</resume>

<location_rule>
${prefs.locationRule}
</location_rule>

<leveling_notes>
${prefs.notes}
</leveling_notes>

Grade fit on the candidate's actual experience and seniority:
- High: strong match on level and core skills; worth applying today.
- Medium: plausible match with a gap or two.
- Low: weak match.
- Reject: wrong discipline or level, or the location rule fails.
Set location_ok from the location rule alone, reading the title and description, not only the location field. Never invent experience the résumé doesn't show.`;
}

function jobPrompt(job: Job, maxChars?: number): string {
  const desc =
    maxChars && job.description.length > maxChars
      ? `${job.description.slice(0, maxChars)}\n[description shortened for this model]`
      : job.description;
  return `<job>
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || "(not given)"}
Workplace: ${job.workplace || "(not given)"}
Salary: ${job.salary || "(not given)"}

${desc}
</job>`;
}

export type ScoringEnv = {
  ANTHROPIC_API_KEY?: string;
  SCORE_MODEL?: string;
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI: Ai;
};

/** Route Anthropic calls through Cloudflare AI Gateway when one is configured. */
export function anthropicBaseURL(env: ScoringEnv): string | undefined {
  return env.CF_ACCOUNT_ID && env.AI_GATEWAY_ID
    ? `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`
    : undefined;
}

async function scoreWithClaude(
  env: ScoringEnv,
  resume: string,
  prefs: Prefs,
  job: Job
): Promise<Score> {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: anthropicBaseURL(env)
  });
  const model = env.SCORE_MODEL || "claude-opus-5-5";
  const response = await client.beta.messages.create({
    model,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // The résumé + rules prefix is identical for every job in a scan, so cache it.
    system: [
      {
        type: "text",
        text: systemPrompt(resume, prefs),
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [{ role: "user", content: jobPrompt(job) }],
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SCORE_SCHEMA }
    }
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude declined to score ${job.title}`);
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text")
    throw new Error("Claude returned no text block");
  return {
    ...(JSON.parse(text.text) as Omit<Score, "model">),
    model: response.model
  };
}

async function scoreWithLlama(
  env: ScoringEnv,
  resume: string,
  prefs: Prefs,
  job: Job
): Promise<Score> {
  const result = (await env.AI.run(LLAMA, {
    messages: [
      { role: "system", content: systemPrompt(resume, prefs) },
      { role: "user", content: jobPrompt(job, LLAMA_MAX_DESCRIPTION_CHARS) }
    ],
    response_format: { type: "json_schema", json_schema: SCORE_SCHEMA },
    max_tokens: 400
  })) as { response?: unknown };
  const parsed =
    typeof result.response === "string"
      ? JSON.parse(result.response)
      : result.response;
  const score = parsed as Omit<Score, "model">;
  // Llama tends to ignore the one-sentence instruction; keep stored rationales readable.
  const rationale =
    score.rationale.length > 300
      ? `${score.rationale.slice(0, 297)}…`
      : score.rationale;
  return { ...score, rationale, model: LLAMA };
}

export async function scoreJob(
  env: ScoringEnv,
  resume: string,
  prefs: Prefs,
  job: Job
): Promise<Score> {
  if (env.ANTHROPIC_API_KEY) {
    try {
      return await scoreWithClaude(env, resume, prefs, job);
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw error; // a bad key is a config bug, not a fallback case
      console.warn(`Claude scoring failed, falling back to Llama: ${error}`);
    }
  }
  return scoreWithLlama(env, resume, prefs, job);
}
