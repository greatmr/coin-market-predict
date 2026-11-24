import { Column, type ColumnOptions } from 'typeorm';

import { decimalTransformer } from '../../../common/entities/decimal.transformer.js';

/**
 * Unconstrained `numeric`: LBank prices are stored with exactly the digits the API sent (a fixed
 * scale such as numeric(38,18) would round a price with more fractional digits without notice).
 */
export function ExactNumericColumn(options: ColumnOptions = {}): PropertyDecorator {
  return Column({ ...options, type: 'numeric', transformer: decimalTransformer });
}
