import { z } from 'zod';

/** A file name listed in an export's manifest, e.g. `review_queue.csv` or `manifest.json`. */
export const ExportFileNameSchema = z.string().regex(/^[a-z_]+\.(csv|json)$/);
