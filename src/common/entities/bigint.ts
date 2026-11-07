import { AfterInsert, Column, type ColumnOptions, type ValueTransformer } from 'typeorm';

/**
 * The `pg` driver returns `bigint` as a string. This is the one conversion: it refuses a value a
 * JavaScript number cannot hold exactly instead of losing precision.
 */
export function safeBigintToNumber(value: string | number | bigint): number {
  const asNumber = typeof value === 'string' && !/^-?\d+$/.test(value) ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(asNumber))
    throw new RangeError('Value is not an integer within Number.MAX_SAFE_INTEGER');
  return asNumber;
}

/** For `bigint` columns. Find operators and absent values pass through. */
export const bigintTransformer: ValueTransformer = {
  to: (value: unknown) => (typeof value === 'number' ? safeBigintToNumber(value) : value),
  from: (value: string | number | bigint | null | undefined) =>
    value === null || value === undefined ? value : safeBigintToNumber(value),
};

/** A `bigint` column read and written as a number. */
export function BigintColumn(options: ColumnOptions = {}): PropertyDecorator {
  return Column({ ...options, type: 'bigint', transformer: bigintTransformer });
}

/**
 * Surrogate key `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`, as a number. TypeORM does not
 * apply a transformer to the generated key it merges back after `save()`, hence the listener; raw
 * query rows are not covered either way: pass their ids through `safeBigintToNumber`.
 */
export abstract class HasBigintId {
  @Column({
    type: 'bigint',
    primary: true,
    generated: 'identity',
    generatedIdentity: 'ALWAYS',
    transformer: bigintTransformer,
  })
  id!: number;

  @AfterInsert()
  protected normalizeGeneratedId(): void {
    this.id = safeBigintToNumber(this.id);
  }
}
