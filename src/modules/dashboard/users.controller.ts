import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';

import { type AuthContext, CurrentAuth, RequirePermission } from '../auth/auth.guard.js';
import { UsersService } from '../auth/users.service.js';

import { userHttpError } from './auth.controller.js';
import {
  type CreateUserDto,
  CreateUserSchema,
  type ResetPasswordDto,
  ResetPasswordSchema,
  type UpdateUserDto,
  UpdateUserSchema,
} from './dto/auth.dto.js';
import { UuidSchema } from './dto/common.dto.js';

/** Owner-only user management: list, add, change role or access, reset a password, delete. */
@Controller('users')
@RequirePermission('users:manage')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@Body(new ZodValidationPipe(CreateUserSchema)) body: CreateUserDto) {
    return this.users.create(body).catch(userHttpError);
  }

  @Patch(':id')
  update(
    @CurrentAuth() a: AuthContext,
    @Param('id', new ZodValidationPipe(UuidSchema)) id: string,
    @Body(new ZodValidationPipe(UpdateUserSchema)) body: UpdateUserDto,
  ) {
    return this.users.update(a.user.id, id, body).catch(userHttpError);
  }

  @Post(':id/password')
  @HttpCode(200)
  resetPassword(
    @Param('id', new ZodValidationPipe(UuidSchema)) id: string,
    @Body(new ZodValidationPipe(ResetPasswordSchema)) body: ResetPasswordDto,
  ) {
    return this.users.resetPassword(id, body.password).catch(userHttpError);
  }

  @Delete(':id')
  async remove(
    @CurrentAuth() a: AuthContext,
    @Param('id', new ZodValidationPipe(UuidSchema)) id: string,
  ) {
    await this.users.remove(a.user.id, id).catch(userHttpError);
    return { deleted: true };
  }
}
