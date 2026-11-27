import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M019: Claude chat (docs/adr/0012-owner-chat.md). A conversation per owner chat and its messages.
 * The limit counts user messages (`counts_toward_limit`) per conversation. The enum values mirror
 * `modules/agent/chat/chat.constants.ts`.
 */
export class M019Chat1793923200019 implements MigrationInterface {
  name = 'M019Chat1793923200019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE chat_role AS ENUM ('user', 'assistant')`);
    await queryRunner.query(
      `CREATE TYPE chat_message_status AS ENUM ('DONE', 'RUNNING', 'FAILED')`,
    );
    await queryRunner.query(`CREATE TABLE chat_conversation (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_id         uuid,
  owner_name       text NOT NULL,
  title            text NOT NULL,
  strategy_version text NOT NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CONSTRAINT chat_conversation_pkey PRIMARY KEY (id),
  CONSTRAINT chat_conversation_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES app_user (id) ON DELETE SET NULL
)`);
    await queryRunner.query(
      `CREATE INDEX ix_chat_conversation_owner ON chat_conversation (owner_id, updated_at)`,
    );
    await queryRunner.query(`CREATE TABLE chat_message (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL,
  seq                 integer NOT NULL,
  role                chat_role NOT NULL,
  status              chat_message_status NOT NULL,
  content             text NOT NULL,
  model               text,
  effort              text,
  prompt_version      text,
  strategy_version    text,
  counts_toward_limit boolean NOT NULL DEFAULT true,
  tool_calls          jsonb NOT NULL DEFAULT '[]',
  usage               jsonb,
  error_kind          text,
  error_message       text,
  created_at          timestamptz NOT NULL,
  finished_at         timestamptz,
  CONSTRAINT chat_message_pkey PRIMARY KEY (id),
  CONSTRAINT chat_message_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES chat_conversation (id) ON DELETE CASCADE,
  CONSTRAINT chat_message_user_done CHECK (role <> 'user' OR status = 'DONE')
)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX ix_chat_message_conversation ON chat_message (conversation_id, seq)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE chat_message`);
    await queryRunner.query(`DROP TABLE chat_conversation`);
    await queryRunner.query(`DROP TYPE chat_message_status`);
    await queryRunner.query(`DROP TYPE chat_role`);
  }
}
