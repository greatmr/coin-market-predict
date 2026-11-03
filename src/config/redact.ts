import { SECRET_KEYS, redactUrlCredentials } from "./config.js";

const registered = new Set<string>();

/** Register secret values so any later log line or error message containing them is masked. */
export function registerSecrets(values: Array<string | undefined>): void {
  for (const v of values) if (v && v.length >= 6) registered.add(v);
}

export function registerSecretsFromEnv(env: Record<string, string | undefined> = process.env): void {
  registerSecrets(SECRET_KEYS.map((k) => env[k]));
}

const PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot tokens appear in API URLs: /bot<id>:<secret>/
  [/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, "bot<redacted>"],
  // Claude OAuth / API key shapes
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-<redacted>"],
  [/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted>"],
  [/(authorization|x-api-key|x-cmc_pro_api_key|x-cg-demo-api-key|x-cg-pro-api-key)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s)([^\s"',]+)/gi, "$1$2<redacted>"],
];

export function redact(input: unknown): string {
  let text = typeof input === "string" ? input : input instanceof Error ? `${input.name}: ${input.message}` : safeJson(input);
  for (const secret of registered) text = text.split(secret).join("<redacted>");
  for (const [re, rep] of PATTERNS) text = text.replace(re, rep);
  return redactUrlCredentials(text);
}

function safeJson(v: unknown): string {
  try {
    // JSON.stringify returns undefined for undefined/functions/symbols.
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
