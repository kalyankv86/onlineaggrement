import { Controller, Get, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX } from '../common/database/database.module';
import { EsignService } from '../esign/esign.service';
import { StorageDriver } from '../documents/storage/storage.driver';
import { Public } from '../auth/auth.guard';

@Controller('api/v1/health')
export class HealthController {
  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly esign: EsignService,
    private readonly storage: StorageDriver,
  ) {}

  /** Liveness — is the process up. Never touches dependencies. */
  @Public()
  @Get()
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Readiness — should the load balancer send traffic here.
   *
   * Storage is checked on every call, not only at boot. A NAS export can go away
   * while the process keeps running, and an instance that cannot reach the
   * document store must stop receiving signers rather than fail them one at a time.
   */
  @Public()
  @Get('ready')
  async ready() {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      await this.knex.raw('SELECT 1');
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, detail: (e as Error).message };
    }

    const storage = await this.storage.health();
    checks.storage = { ok: storage.ok, detail: storage.detail };

    const caps = this.esign.capabilities();
    checks.esignProvider = { ok: true, detail: `${caps.name} (${caps.mode} mode)` };

    return { status: Object.values(checks).every((c) => c.ok) ? 'ready' : 'degraded', checks };
  }
}
