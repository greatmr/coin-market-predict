import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { basename } from 'node:path';

import { ErrorCodes } from '../../common/dto/error-codes.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { ReadModelService } from '../read-model/read-model.service.js';

import { UuidSchema } from './dto/common.dto.js';
import { ExportFileNameSchema } from './dto/exports.dto.js';

/** Per-batch export files (CSV per sheet, XLSX workbook, SHA-256 manifest). */
@Controller('exports')
export class ExportsController {
  constructor(private readonly read: ReadModelService) {}

  @Get()
  list() {
    return this.read.exportsList(48);
  }

  /** A file download (not enveloped); only files listed in that batch's export are served. */
  @Get(':batchId/:file')
  async file(
    @Param('batchId', new ZodValidationPipe(UuidSchema)) batchId: string,
    @Param('file', new ZodValidationPipe(ExportFileNameSchema)) file: string,
    @Res() res: Response,
  ) {
    const path = await this.read.exportFile(batchId, file);
    if (!path)
      throw new NotFoundException({
        message: 'export file not found',
        code: ErrorCodes.EXPORT_FILE_NOT_FOUND,
      });
    res.download(path, `${batchId.slice(0, 8)}_${basename(path)}`);
  }
}
