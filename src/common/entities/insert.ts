import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';

/** Rows per INSERT statement: keeps every statement far below PostgreSQL's 65 535 parameters. */
const CHUNK = 1000;

/**
 * Multi-row INSERT in chunks; returns the number of rows inserted. With `ignoreConflicts`, rows
 * that hit a unique constraint are skipped (`ON CONFLICT DO NOTHING`): first write wins, which is
 * what makes replays and concurrent writers idempotent.
 */
export async function insertRows<T extends ObjectLiteral>(
  manager: EntityManager,
  target: EntityTarget<T>,
  rows: Array<QueryDeepPartialEntity<T>>,
  opts: { ignoreConflicts?: boolean } = {},
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    let qb = manager
      .createQueryBuilder()
      .insert()
      .into(target)
      .values(rows.slice(i, i + CHUNK))
      .updateEntity(false)
      .returning('1');
    if (opts.ignoreConflicts) qb = qb.orIgnore();
    const result = await qb.execute();
    inserted += Array.isArray(result.raw) ? result.raw.length : 0;
  }
  return inserted;
}
