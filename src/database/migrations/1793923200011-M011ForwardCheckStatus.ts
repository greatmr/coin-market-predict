import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M011: per-event High check status for the forward test (docs/forward-test.md § 7). Four tracking
 * columns on `forward_event` — the last check attempt, its result, a note and the date through
 * which every closed day has a usable High — so the dashboard can tell "not checked yet", "checked,
 * record unchanged", "new record", "data unavailable" and "retrieval error" apart. They are
 * bookkeeping, not part of an outcome, so FORWARD_RULES_VERSION is unchanged.
 *
 * The immutability trigger from M008 compares every column except the mutable ones, so the new
 * columns are added to its list. Existing events are back-filled from their stored outcomes.
 */
const MUTABLE_BEFORE = [
  'status',
  'quality_flags',
  'result_version',
  'last_update_at',
  'finalized_at',
  'updated_at',
  'snapshot_id',
  'trigger_run_id',
];
const MUTABLE_AFTER = [
  ...MUTABLE_BEFORE,
  'last_check_at',
  'last_check_status',
  'last_check_note',
  'checked_through',
];

const triggerFunction = (mutable: readonly string[]) => {
  const list = `ARRAY[${mutable.map((c) => `'${c}'`).join(', ')}]::text[]`;
  return `CREATE OR REPLACE FUNCTION forward_event_immutable_snapshot() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ${list})
     IS DISTINCT FROM
     (to_jsonb(OLD) - ${list}) THEN
    RAISE EXCEPTION 'forward_event %: the detection snapshot is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$`;
};

export class M011ForwardCheckStatus1793923200011 implements MigrationInterface {
  name = 'M011ForwardCheckStatus1793923200011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE forward_check_status AS ENUM ('NEW_RECORD', 'UNCHANGED', 'DATA_UNAVAILABLE', 'RETRIEVAL_ERROR')`,
    );
    await queryRunner.query(`ALTER TABLE forward_event
  ADD COLUMN last_check_at timestamptz,
  ADD COLUMN last_check_status forward_check_status,
  ADD COLUMN last_check_note text,
  ADD COLUMN checked_through date`);
    await queryRunner.query(triggerFunction(MUTABLE_AFTER));

    // Back-fill from the latest outcome: the same rules as checkStatus() and the outcome's
    // checkedThrough (the closed days before the first missing or invalid date).
    await queryRunner.query(`UPDATE forward_event e SET
  last_check_at = e.last_update_at,
  last_check_status = (CASE
    WHEN cardinality(o.missing_dates) > 0 OR cardinality(o.invalid_dates) > 0 THEN 'DATA_UNAVAILABLE'
    WHEN o.peak_high_usd IS NOT NULL AND o.peak_high_usd IS DISTINCT FROM (
      SELECT p.peak_high_usd FROM forward_outcome p
       WHERE p.event_id = e.id AND p.result_version = o.result_version - 1) THEN 'NEW_RECORD'
    ELSE 'UNCHANGED' END)::forward_check_status,
  checked_through = (SELECT CASE WHEN x.d < e.detected_utc_date THEN NULL ELSE x.d END FROM (
    SELECT LEAST(
      e.detected_utc_date + (o.completed_days - 1),
      (SELECT min(g.d) - 1 FROM (
         SELECT m::date AS d FROM unnest(o.missing_dates) m
         UNION ALL SELECT left(i, 10)::date FROM unnest(o.invalid_dates) i) g)) AS d) x)
FROM forward_outcome o
WHERE o.event_id = e.id AND o.result_version = e.result_version AND e.result_version > 0
  AND o.completed_days > 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(triggerFunction(MUTABLE_BEFORE));
    await queryRunner.query(`ALTER TABLE forward_event
  DROP COLUMN checked_through,
  DROP COLUMN last_check_note,
  DROP COLUMN last_check_status,
  DROP COLUMN last_check_at`);
    await queryRunner.query(`DROP TYPE forward_check_status`);
  }
}
