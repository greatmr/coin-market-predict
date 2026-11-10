import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M010: dashboard settings (`docs/adr/0005-dashboard-settings.md`). `app_setting` holds the
 * operational settings an owner saved under Settings (one row per key; no row = environment or
 * default); `app_setting_change` is the append-only history of every save, reset and import, with
 * who made it. Secrets are never stored here: the keys are limited to the catalog in
 * `config/settings.catalog.ts`, which contains no credential.
 */
export class M010DashboardSettings1793923200010 implements MigrationInterface {
  name = 'M010DashboardSettings1793923200010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE setting_change_source AS ENUM ('dashboard', 'cli', 'import_env')`,
    );
    await queryRunner.query(`CREATE TABLE app_setting (
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_setting_pkey PRIMARY KEY (key),
  CONSTRAINT app_setting_value_scalar CHECK (jsonb_typeof(value) IN ('string', 'number', 'boolean')),
  CONSTRAINT app_setting_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES app_user (id) ON DELETE SET NULL
)`);
    await queryRunner.query(`CREATE TABLE app_setting_change (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  key             text NOT NULL,
  old_value       jsonb,
  new_value       jsonb,
  source          setting_change_source NOT NULL,
  changed_by      uuid,
  changed_by_name text NOT NULL,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_setting_change_pkey PRIMARY KEY (id),
  CONSTRAINT app_setting_change_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES app_user (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_app_setting_change_changed_at ON app_setting_change (changed_at)`,
    );
    // The history is append-only: a correction is a new change, never an edit or a deletion. The one
    // update allowed is the foreign key clearing `changed_by` when that user is deleted (the name
    // stays in `changed_by_name`).
    await queryRunner.query(`CREATE FUNCTION app_setting_change_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.changed_by IS NULL
     AND (to_jsonb(NEW) - 'changed_by') = (to_jsonb(OLD) - 'changed_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'app_setting_change % is append-only', OLD.id
    USING ERRCODE = 'check_violation';
END
$$`);
    await queryRunner.query(
      `CREATE TRIGGER app_setting_change_append_only BEFORE UPDATE OR DELETE ON app_setting_change FOR EACH ROW EXECUTE FUNCTION app_setting_change_append_only()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE app_setting_change`);
    await queryRunner.query(`DROP FUNCTION app_setting_change_append_only()`);
    await queryRunner.query(`DROP TABLE app_setting`);
    await queryRunner.query(`DROP TYPE setting_change_source`);
  }
}
