import { Column, type ColumnOptions, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** `created_at timestamptz NOT NULL DEFAULT now()`. */
export const CreatedAtColumn = (): PropertyDecorator =>
  CreateDateColumn({ name: 'created_at', type: 'timestamptz' });

/** `updated_at timestamptz NOT NULL DEFAULT now()`, refreshed by every TypeORM update and upsert. */
export const UpdatedAtColumn = (): PropertyDecorator =>
  UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' });

/** `text[] NOT NULL DEFAULT '{}'` (pass `nullable`/`default` to change it). */
export const TextArrayColumn = (name: string, options: ColumnOptions = {}): PropertyDecorator =>
  Column({ default: () => "'{}'", ...options, name, type: 'text', array: true });

/** `integer[] NOT NULL DEFAULT '{}'`. */
export const IntArrayColumn = (name: string): PropertyDecorator =>
  Column({ name, type: 'integer', array: true, default: () => "'{}'" });
