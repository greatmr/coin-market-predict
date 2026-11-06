import { DefaultNamingStrategy, type Table } from 'typeorm';

/**
 * Constraint names as PostgreSQL itself names them (`<table>_pkey`, `<table>_<columns>_key`,
 * `<table>_<columns>_fkey`) instead of TypeORM's hashes, so the migrations' SQL, the entities and the
 * drift check (`test/schema-drift.e2e-spec.ts`) agree. Index, unique and check names are explicit in
 * the entities; column names are explicit snake_case.
 */
export class PostgresNamingStrategy extends DefaultNamingStrategy {
  private tableOf(tableOrName: Table | string): string {
    return this.getTableName(tableOrName);
  }

  override primaryKeyName(tableOrName: Table | string): string {
    return `${this.tableOf(tableOrName)}_pkey`;
  }

  override uniqueConstraintName(tableOrName: Table | string, columnNames: string[]): string {
    return `${this.tableOf(tableOrName)}_${columnNames.join('_')}_key`;
  }

  override relationConstraintName(tableOrName: Table | string, columnNames: string[]): string {
    return `${this.tableOf(tableOrName)}_${columnNames.join('_')}_key`;
  }

  override foreignKeyName(tableOrName: Table | string, columnNames: string[]): string {
    return `${this.tableOf(tableOrName)}_${columnNames.join('_')}_fkey`;
  }
}
