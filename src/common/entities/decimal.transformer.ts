import { Column, type ColumnOptions, type ValueTransformer } from 'typeorm';

import { D, type DValue, Decimal } from '../utils/decimal.js';

/**
 * `numeric` columns are exact: the driver returns their text, which is read into a `D` decimal
 * (80 significant digits, see `common/utils/decimal.ts`) and never into a JS float. Writes accept a
 * decimal (written in plain notation), a decimal string or a number.
 */
export const decimalTransformer: ValueTransformer = {
  to: (value: unknown) => (Decimal.isDecimal(value) ? (value as DValue).toFixed() : value),
  from: (value: string | null | undefined) =>
    value === null || value === undefined ? value : new D(value),
};

/** `numeric(precision, scale)` read as an exact decimal. */
export function DecimalColumn(
  precision: number,
  scale: number,
  options: ColumnOptions = {},
): PropertyDecorator {
  return Column({ ...options, type: 'numeric', precision, scale, transformer: decimalTransformer });
}
