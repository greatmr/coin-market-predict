import { CronTime } from "cron";

/**
 * discover → collect (existing crawler batch) → lbank (LBank Spot pairs) → daily (completed UTC
 * rows) → scan (Tier 1) → venues (CMC Markets rows for review candidates) → export → notify.
 */
export const STAGES = ["discover", "collect", "lbank", "daily", "scan", "venues", "export", "notify"] as const;
export type Stage = (typeof STAGES)[number];

/** Item progress inside a long stage (per-coin loops), stored as `PipelineRun.metrics.progress`. */
export interface StageProgress {
  stage: Stage;
  unit: string;
  done: number;
  total: number;
}

export interface RunProgress {
  stagesDone: number;
  stagesTotal: number;
  /** Whole-run estimate: finished stages plus the finished share of the current stage; < 100 while running. */
  percent: number;
  current: (StageProgress & { etaSeconds: number | null }) | null;
}

/** Text progress bar for the run log: `[████░░░░] 4/8`. */
export function progressBar(done: number, total: number, width = 8): string {
  const filled = Math.round((Math.min(done, total) / total) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${done}/${total}`;
}

function isStageProgress(v: unknown): v is StageProgress {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.stage === "string" && typeof p.unit === "string" && Number.isFinite(p.done) && Number.isFinite(p.total) && (p.total as number) > 0;
}

/**
 * Progress of a running pipeline run for the dashboard. A stage counts as finished once it
 * succeeded or failed (failures of non-fatal stages do not stop the run). Item progress is used
 * only when it belongs to the stage that is running now.
 */
export function runProgress(input: { stages: Array<{ stage: string; status: string; startedAt: Date | string | null }>; currentStage: string | null; progress: unknown; now: Date }): RunProgress {
  const finished = new Set(input.stages.filter((s) => s.status === "succeeded" || s.status === "failed").map((s) => s.stage));
  const current = input.currentStage && (STAGES as readonly string[]).includes(input.currentStage) ? input.currentStage : null;
  if (current) finished.delete(current);
  const stagesDone = STAGES.filter((s) => finished.has(s)).length;
  let item: RunProgress["current"] = null;
  let fraction = 0;
  if (current && isStageProgress(input.progress) && input.progress.stage === current) {
    const { stage, unit, total } = input.progress;
    const done = Math.min(Math.max(0, input.progress.done), total);
    fraction = done / total;
    const startedAt = input.stages.find((s) => s.stage === current)?.startedAt;
    const elapsed = startedAt ? (input.now.getTime() - new Date(startedAt).getTime()) / 1000 : null;
    const etaSeconds = elapsed !== null && elapsed > 0 && done > 0 && done < total ? Math.round((elapsed / done) * (total - done)) : null;
    item = { stage, unit, done, total, etaSeconds };
  }
  const percent = Math.min(99, Math.floor(((stagesDone + fraction) / STAGES.length) * 100));
  return { stagesDone, stagesTotal: STAGES.length, percent, current: item };
}

/** Next UTC fire time of a cron expression, or null when the expression is invalid. */
export function nextCronRun(expr: string, from?: Date): string | null {
  try {
    const t = new CronTime(expr, "UTC");
    // getNextDateFrom ignores the CronTime's zone unless it is passed again.
    return (from ? t.getNextDateFrom(from, "UTC") : t.sendAt()).toUTC().toISO();
  } catch {
    return null;
  }
}
