import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../config/config.js";
import { RUNTIME_DIR, RUNTIME_PLUGIN_NAME } from "./claude-runner.js";
import type { AgentRole } from "./runner.js";

/**
 * Model routing and per-role limits. Model ids come only from configuration.
 *  - market_analyst: ambiguous interpretation → stronger model (default Sonnet).
 *  - risk_reviewer: critical review → stronger model; escalates to AGENT_MODEL_ESCALATION
 *    (default Opus) only on analyst/reviewer disagreement or low reviewer confidence.
 *  - coordinator: merging + summary formatting → economical model (default Haiku).
 */
export interface RoleConfig {
  role: AgentRole;
  model: string;
  promptFile: string;
  skills: string[];
  budgetShare: number;
  effort: "low" | "medium" | "high";
  maxTurns: (assets: number) => number;
}

export function roleConfigs(cfg: AppConfig): Record<AgentRole, RoleConfig> {
  const skill = (s: string) => `${RUNTIME_PLUGIN_NAME}:${s}`;
  return {
    market_analyst: {
      role: "market_analyst",
      model: cfg.AGENT_MODEL_ANALYST,
      promptFile: "market-analyst.md",
      skills: [skill("market-analysis")],
      budgetShare: 0.45,
      effort: "medium",
      maxTurns: (n) => 8 + 2 * n,
    },
    risk_reviewer: {
      role: "risk_reviewer",
      model: cfg.AGENT_MODEL_REVIEWER,
      promptFile: "risk-reviewer.md",
      skills: [skill("risk-review")],
      budgetShare: 0.3,
      effort: "medium",
      maxTurns: (n) => 8 + 2 * n,
    },
    coordinator: {
      role: "coordinator",
      model: cfg.AGENT_MODEL_COORDINATOR,
      promptFile: "coordinator.md",
      skills: [skill("report-preparation")],
      budgetShare: 0.1,
      effort: "low",
      maxTurns: (n) => 6 + n,
    },
  };
}

export const ESCALATION_BUDGET_SHARE = 0.15;

const cache = new Map<string, string>();

/** Production system prompt = shared runtime rules + role prompt (explicitly loaded files). */
export function systemPromptFor(role: RoleConfig): string {
  const read = (f: string) => {
    if (!cache.has(f)) cache.set(f, readFileSync(resolve(RUNTIME_DIR, "agents", f), "utf8"));
    return cache.get(f)!;
  };
  return `${read("_common.md")}\n\n${read(role.promptFile)}`;
}
