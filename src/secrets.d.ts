// Secrets are set with `wrangler secret put` (or .dev.vars locally), so `wrangler types`
// can't see them. Both are optional: without ANTHROPIC_API_KEY everything runs on Llama 3.3.
interface Env {
  ANTHROPIC_API_KEY?: string;
  APP_TOKEN?: string;
}
