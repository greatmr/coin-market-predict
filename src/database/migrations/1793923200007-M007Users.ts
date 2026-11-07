import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M007: dashboard users (owner / analyzer / reviewer) and their sessions. No account is created
 * here: the web server creates the bootstrap owner on start when no active owner exists, and the
 * CLI can (re)create one (`users:reset-owner`), so an emptied database never locks the owner out.
 */
export class M007Users1793923200007 implements MigrationInterface {
  name = 'M007Users1793923200007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE user_role AS ENUM ('owner', 'analyzer', 'reviewer')`);
    await queryRunner.query(`CREATE TABLE app_user (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  username             text NOT NULL,
  role                 user_role NOT NULL,
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  is_active            boolean NOT NULL DEFAULT true,
  failed_logins        integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_pkey PRIMARY KEY (id),
  CONSTRAINT app_user_username_key UNIQUE (username)
)`);
    await queryRunner.query(`CREATE TABLE user_session (
  id           text NOT NULL,
  user_id      uuid NOT NULL,
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_session_pkey PRIMARY KEY (id),
  CONSTRAINT user_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE
)`);
    await queryRunner.query(`CREATE INDEX ix_user_session_user ON user_session (user_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE user_session`);
    await queryRunner.query(`DROP TABLE app_user`);
    await queryRunner.query(`DROP TYPE user_role`);
  }
}
