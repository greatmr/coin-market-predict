import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M010: Claude coin agent history (docs/adr/0005-coin-agent.md). One row per run: written as
 * RUNNING when it starts, completed once as SUCCEEDED or FAILED, then immutable (trigger). The run
 * limit (AGENT_MAX_RUNS per AGENT_WINDOW_HOURS) counts rows by `requested_at`. The enum values
 * mirror `modules/agent/agent.constants.ts`.
 */
const ENUMS: ReadonlyArray<readonly [name: string, values: readonly string[]]> = [
  ['agent_run_status', ['RUNNING', 'SUCCEEDED', 'FAILED']],
  ['agent_outlook', ['PUMP_LIKELY', 'PUMP_POSSIBLE', 'PUMP_UNLIKELY', 'INSUFFICIENT_DATA']],
  ['agent_confidence', ['LOW', 'MEDIUM', 'HIGH']],
];

export class M010AgentAnalysis1793923200010 implements MigrationInterface {
  name = 'M010AgentAnalysis1793923200010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, values] of ENUMS)
      await queryRunner.query(
        `CREATE TYPE ${name} AS ENUM (${values.map((v) => `'${v}'`).join(', ')})`,
      );
    await queryRunner.query(`CREATE TABLE agent_analysis (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_id         text NOT NULL,
  cmc_id              integer NOT NULL,
  symbol              text NOT NULL,
  name                text NOT NULL,
  batch_id            uuid NOT NULL,
  is_live             boolean NOT NULL,
  requested_by        text NOT NULL,
  requested_by_id     uuid,
  requested_at        timestamptz NOT NULL,
  finished_at         timestamptz,
  status              agent_run_status NOT NULL,
  counts_toward_limit boolean NOT NULL DEFAULT true,
  model               text NOT NULL,
  fallback_model      text,
  effort              text NOT NULL,
  prompt_version      text NOT NULL,
  ruleset_version     text NOT NULL,
  outlook             agent_outlook,
  confidence          agent_confidence,
  output              jsonb,
  guardrail_notes     text[] NOT NULL DEFAULT '{}',
  tool_calls          jsonb NOT NULL,
  usage               jsonb,
  error_kind          text,
  error_message       text,
  CONSTRAINT agent_analysis_pkey PRIMARY KEY (id),
  CONSTRAINT agent_analysis_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES provider (id) ON DELETE RESTRICT,
  CONSTRAINT agent_analysis_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES crawl_batch (id) ON DELETE RESTRICT,
  CONSTRAINT agent_analysis_requested_by_id_fkey FOREIGN KEY (requested_by_id) REFERENCES app_user (id) ON DELETE SET NULL,
  CONSTRAINT agent_analysis_finished_consistent CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
  CONSTRAINT agent_analysis_success_has_output CHECK (status <> 'SUCCEEDED' OR (output IS NOT NULL AND outlook IS NOT NULL AND confidence IS NOT NULL))
)`);
    await queryRunner.query(
      `CREATE INDEX ix_agent_analysis_coin ON agent_analysis (provider_id, cmc_id, requested_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX ix_agent_analysis_requested ON agent_analysis (requested_at)`,
    );
    // A finished analysis is history: nothing changes it except the requester link that
    // ON DELETE SET NULL clears when the account is deleted (the username stays).
    await queryRunner.query(`CREATE FUNCTION agent_analysis_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'RUNNING'
     AND (to_jsonb(NEW) - 'requested_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'requested_by_id') THEN
    RAISE EXCEPTION 'agent_analysis %: a finished analysis is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`);
    await queryRunner.query(
      `CREATE TRIGGER agent_analysis_immutable BEFORE UPDATE ON agent_analysis FOR EACH ROW EXECUTE FUNCTION agent_analysis_immutable()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE agent_analysis`);
    await queryRunner.query(`DROP FUNCTION agent_analysis_immutable()`);
    for (const [name] of [...ENUMS].reverse()) await queryRunner.query(`DROP TYPE ${name}`);
  }
}
