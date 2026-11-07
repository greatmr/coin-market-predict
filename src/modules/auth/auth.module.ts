import { Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';

import { AuthService } from './auth.service.js';
import { UsersService } from './users.service.js';

/** Creates the bootstrap owner when the web server starts on a database without an active owner. */
@Injectable()
export class OwnerBootstrap implements OnApplicationBootstrap {
  constructor(private readonly users: UsersService) {}

  async onApplicationBootstrap() {
    await this.users.ensureOwner();
  }
}

/**
 * Dashboard users and sessions (no HTTP here: routes live in the dashboard module, which also
 * registers the guard and the owner bootstrap). Loaded by every entry point so the CLI can manage
 * users on an empty database.
 */
@Module({
  providers: [AuthService, UsersService],
  exports: [AuthService, UsersService],
})
export class AuthModule {}
