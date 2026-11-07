import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { DataSource } from 'typeorm';

import { RedactingLogger } from './common/logging/redacting.logger.js';
import { redact } from './common/security/redact.js';
import { sha256 } from './common/utils/decimal.js';
import { slotOf } from './common/utils/time.js';

import { type AppConfig, describeConfig } from './config/index.js';
import { loadConfigOrExit } from './config/load-config.js';

import { buildDataSourceOptions } from './database/typeorm-options.js';

import { USER_ROLES, type UserRole } from './modules/auth/permissions.js';
import { BOOTSTRAP_OWNER, UserError, UsersService } from './modules/auth/users.service.js';
import { parseCmcHistoryCsv } from './modules/daily-metrics/csv-import.js';
import { DailyMetricsService } from './modules/daily-metrics/daily-metrics.service.js';
import { IngestionService } from './modules/ingestion/ingestion.service.js';
import { PipelineService } from './modules/pipeline/pipeline.service.js';
import { ReadModelService } from './modules/read-model/read-model.service.js';
import { isCmcIdProvider } from './modules/sources/cmc-id-providers.js';
import { SourceHealthService } from './modules/sources/source-health.service.js';
import { parseDocumentPart } from './modules/telegram/attachment.js';
import { formatTier1Report } from './modules/telegram/format.js';
import { ReportService } from './modules/telegram/report.service.js';
import { TelegramService } from './modules/telegram/telegram.service.js';
import { VenuesService } from './modules/venues/venues.service.js';

import { AppModule } from './app.module.js';

const HELP = `Coins Predicts CLI — Two-Tier VMC strategy (docs/strategy-two-tier-vmc.md)

  config:check                 Validate configuration (secrets shown only as set/not set)
  db:migrate                   Apply pending database migrations (src/database/migrations)
  db:status                    List applied and pending migrations
  db:revert                    Undo the most recently applied migration (asks no question: be sure)
  run-once [--slot ISO] [--force] [--kind manual]
                               Run the hourly pipeline for the current (or given) slot:
                               collect → LBank pairs → daily rows → Tier 1 scan → venues → export → Telegram
  discover                     Run listing discovery now
  tier1:scan [--batch ID] [--no-export]
                               Reprocess a saved crawl batch (default: latest) without crawling,
                               then export it (PDF p.18 dry run over saved data)
  tier1:export [--batch ID]    Re-export a scanned batch (CSV per sheet + XLSX + manifest)
  tier1:trace --id CMC_ID [--batch ID] [--json]
                               Full calculation trace for one asset (30 daily rows, windows, rules)
  tier1:batches                Recent crawl batches with scan and export status
  lbank:status                 The stored LBank Spot markets list: fetched when, next automatic refresh
  lbank:refresh                Fetch the LBank Spot markets list now (normally every
                               LBANK_PAIRS_REFRESH_DAYS), then recompute and re-export the latest batch
  daily:import-csv --id CMC_ID --file history.csv
                               Import a CSV downloaded from the coin's CMC "Historical Data" page
                               as completed daily rows (manual source, revisions kept)
  telegram:preview [--batch ID] [--fake]
                               Print the Telegram summary (latest batch, or a fake-data layout)
  telegram:test [--sample]     Verify bot token + chat and send one test message
  telegram:deliver             Send pending live Telegram deliveries
  source:reset [--provider ID] Clear a suspended/open circuit breaker after you resolved the cause

  Dashboard users (passwords are asked at a hidden prompt, or read from stdin when piped)
  users:list                   Usernames, roles, status and last sign-in
  users:add --username U --role owner|analyzer|reviewer
                               Add a user with a temporary password (changed at first sign-in)
  users:password --username U [--keep]
                               Set a new password and unlock the account (--keep: no forced change)
  users:reset-owner            Recovery: make "owner" an active owner with password "owner"
                               (changed at first sign-in), unlocked, all its sessions ended
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(HELP);
    return;
  }
  const cfg = loadConfigOrExit({ ...process.env, SCHEDULER_ENABLED: 'false' });
  if (cmd === 'config:check') {
    process.stdout.write(`${JSON.stringify(describeConfig(cfg), null, 2)}\n`);
    return;
  }
  if (cmd === 'telegram:preview' && process.argv.includes('--fake')) {
    process.stdout.write(
      `${fakePreview(cfg.DISPLAY_TIMEZONE).join('\n\n----- next message -----\n\n')}\n`,
    );
    return;
  }
  if (cmd === 'db:migrate' || cmd === 'db:status' || cmd === 'db:revert') {
    await database(cmd, cfg);
    return;
  }

  const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg, { http: false }), {
    logger: new RedactingLogger(),
  });
  const out = (v: unknown) =>
    process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);
  try {
    switch (cmd) {
      case 'run-once': {
        const slot = arg('--slot') ? new Date(arg('--slot')!) : undefined;
        const r = await ctx.get(PipelineService).runSlot(slot, {
          force: process.argv.includes('--force'),
          kind: arg('--kind') ?? 'hourly',
        });
        out(r);
        if (r.status === 'failed') process.exitCode = 1;
        break;
      }
      case 'discover': {
        const r = await ctx.get(IngestionService).discover(new Date());
        out({
          status: r.status,
          assetsSeen: r.assetsSeen,
          newAssets: r.newAssets,
          complete: r.coverageComplete,
          sourceTotal: r.sourceTotal,
        });
        break;
      }
      case 'tier1:scan': {
        const r = await ctx
          .get(PipelineService)
          .reprocess(arg('--batch'), { export: !process.argv.includes('--no-export') });
        out(
          r.skipped
            ? r
            : {
                batchId: r.batchId,
                queueStatus: r.scan?.queueStatus,
                counts: r.scan?.counts,
                warnings: r.scan?.warnings,
                export: r.export,
              },
        );
        if (r.skipped || r.export?.status === 'failed') process.exitCode = 1;
        break;
      }
      case 'tier1:export': {
        const batchId = arg('--batch') ?? (await ctx.get(ReadModelService).latestScanBatchId());
        if (!batchId) throw new Error('no scanned batch yet; run `npm run cli -- run-once` first');
        const r = await ctx.get(PipelineService).exportBatch(batchId);
        out(r);
        if ('skipped' in r || r.status === 'failed') process.exitCode = 1;
        break;
      }
      case 'tier1:trace': {
        const id = Number(arg('--id'));
        if (!Number.isSafeInteger(id) || id <= 0)
          throw new Error('usage: tier1:trace --id <CMC id> [--batch <batch id>] [--json]');
        const t = await ctx.get(ReadModelService).assetTrace(id, arg('--batch'));
        if (!t) throw new Error(`no Tier 1 record for CMC id ${id}`);
        out(process.argv.includes('--json') ? t : renderTrace(t));
        break;
      }
      case 'lbank:status': {
        out(
          (await ctx.get(VenuesService).lbankListStatus(cfg.DATA_SOURCE)) ?? {
            list: null,
            note: 'no complete LBank Spot markets list yet; it is fetched by the next run or `lbank:refresh`',
          },
        );
        break;
      }
      case 'lbank:refresh': {
        const r = await ctx.get(PipelineService).refreshLbankPairs();
        out(
          'skipped' in r
            ? r
            : {
                lbank: r.lbank,
                batchId: r.batchId,
                queueStatus: r.scan?.queueStatus ?? null,
                counts: r.scan?.counts ?? null,
                export: r.export?.status ?? null,
              },
        );
        if ('skipped' in r || !r.lbank.usable) process.exitCode = 1;
        break;
      }
      case 'tier1:batches': {
        const rows = await ctx.get(ReadModelService).batches(24);
        out(
          rows
            .map((b) => {
              const s = b.scan as {
                status?: string;
                queueStatus?: string;
                counts?: Record<string, number>;
                exportStatus?: string;
              } | null;
              return `${String(b.slotTime)}  ${String(b.status).padEnd(10)} collected ${String(b.collected).padStart(5)}  scan ${s?.status ?? '-'} ${s?.queueStatus ?? ''} queue ${s?.counts?.queue ?? '-'} eligible ${s?.counts?.eligible ?? '-'} review ${s?.counts?.needsReview ?? '-'} export ${s?.exportStatus ?? '-'}  ${String(b.id)}`;
            })
            .join('\n'),
        );
        break;
      }
      case 'daily:import-csv': {
        const file = arg('--file');
        const id = Number(arg('--id'));
        if (!file || !Number.isSafeInteger(id) || id < 1)
          throw new Error('usage: daily:import-csv --id <CMC id> --file <downloaded.csv>');
        if (!isCmcIdProvider(cfg.DATA_SOURCE))
          throw new Error(`DATA_SOURCE=${cfg.DATA_SOURCE} does not use CMC ids`);
        const text = readFileSync(file, 'utf8');
        const parsed = parseCmcHistoryCsv(text, id, new Date());
        // Daily rows reference their provider: make sure the configured source is registered.
        await ctx.get(IngestionService).ensureProvider();
        const counts = await ctx.get(DailyMetricsService).upsertRows(cfg.DATA_SOURCE, parsed.rows, {
          source: 'manual_csv_import',
          params: { file: basename(file), cmcId: String(id) },
          responseSha256: sha256(text),
          retrievedAt: new Date(),
          batchId: null,
        });
        out({
          cmcId: id,
          provider: cfg.DATA_SOURCE,
          rows: parsed.rows.length,
          range: {
            first: parsed.rows[0]?.dateUtc ?? null,
            last: parsed.rows.at(-1)?.dateUtc ?? null,
          },
          skippedIncompleteDay: parsed.skippedIncomplete,
          skippedUnparseable: parsed.skippedUnparseable,
          ...counts,
          note: 'Rows apply from the next scan; run `tier1:scan` to reprocess the latest batch now.',
        });
        break;
      }
      case 'telegram:preview': {
        const batchId = arg('--batch') ?? (await ctx.get(ReadModelService).latestScanBatchId());
        if (!batchId)
          throw new Error(
            'no scanned batch yet; run `npm run cli -- run-once` first, or use --fake',
          );
        // Same coin links as the running bot uses (needs the bot token; falls back to /coin_<id>).
        await ctx.get(TelegramService).loadBotUsername();
        const parts = (await ctx.get(ReportService).build(batchId)).map((p) => {
          const d = parseDocumentPart(p);
          return d
            ? `[attachment] ${d.filename} (${existsSync(d.path) ? `${Math.round(statSync(d.path).size / 1024)} KB` : 'file missing'})\n${d.caption}`
            : p;
        });
        out(parts.join('\n\n----- next message -----\n\n'));
        break;
      }
      case 'telegram:test': {
        const tg = ctx.get(TelegramService);
        const v = await tg.verify();
        out(v);
        if (!v.ok) {
          process.exitCode = 1;
          break;
        }
        const msgs = process.argv.includes('--sample')
          ? fakePreview(cfg.DISPLAY_TIMEZONE)
          : ['<b>Coins Predicts</b> — test message. Telegram delivery is configured.'];
        for (const m of msgs) {
          const r = await tg.sendTest(m);
          out(r.ok ? { sent: true } : { sent: false, error: r.error });
          if (!r.ok) process.exitCode = 1;
        }
        break;
      }
      case 'telegram:deliver':
        out(await ctx.get(TelegramService).deliverPending());
        break;
      case 'source:reset': {
        const provider = arg('--provider') ?? cfg.DATA_SOURCE;
        if (!['fixture', 'coinmarketcap', 'coinmarketcap_web', 'coingecko'].includes(provider))
          throw new Error('unknown source provider');
        await ctx.get(SourceHealthService).reset(provider);
        out(`circuit reset for ${provider}`);
        break;
      }
      case 'users:list': {
        const users = await ctx.get(UsersService).list();
        if (!users.length)
          out('No users yet. The web server creates "owner" on start, or run users:reset-owner.');
        for (const u of users)
          out(
            `${u.username.padEnd(20)} ${u.role.padEnd(9)} ${u.isActive ? (u.lockedUntil ? 'locked' : 'active') : 'disabled'}${u.mustChangePassword ? ', must change password' : ''}  last sign-in ${u.lastLoginAt ?? 'never'}`,
          );
        break;
      }
      case 'users:add': {
        const username = arg('--username');
        const role = arg('--role') as UserRole | undefined;
        if (!username || !role || !USER_ROLES.includes(role))
          throw new Error(`usage: users:add --username U --role ${USER_ROLES.join('|')}`);
        const password = await readSecret(`Temporary password for ${username}: `);
        const u = await ctx
          .get(UsersService)
          .create({ username, role, password })
          .catch(cliUserError);
        out(`added ${u.username} (${u.role}); they choose their own password at first sign-in`);
        break;
      }
      case 'users:password': {
        const username = arg('--username');
        if (!username) throw new Error('usage: users:password --username U [--keep]');
        const users = ctx.get(UsersService);
        const u = await users.findByUsername(username);
        if (!u) throw new Error(`no user named ${username}`);
        const password = await readSecret(`New password for ${u.username}: `);
        const keep = process.argv.includes('--keep');
        await users.resetPassword(u.id, password, { temporary: !keep }).catch(cliUserError);
        out(
          `password set for ${u.username}, account unlocked, sessions ended${keep ? '' : '; it must be changed at next sign-in'}`,
        );
        break;
      }
      case 'users:reset-owner': {
        const u = await ctx.get(UsersService).resetOwner();
        out(
          `"${u.username}" is an active owner with password "${BOOTSTRAP_OWNER.password}". Sign in and choose a new password: the dashboard asks for it first.`,
        );
        break;
      }
      default:
        process.stdout.write(HELP);
        process.exitCode = 2;
    }
  } finally {
    await ctx.close();
  }
}

/** A refused user change as a plain CLI error (its message is written for people). */
function cliUserError(err: unknown): never {
  throw err instanceof UserError ? new Error(err.message) : err;
}

/**
 * A password from a hidden prompt on a terminal, or the first line of stdin when piped
 * (`printf %s "$PASS" | npm run cli -- users:add …`). Never taken from argv, which shell history keeps.
 */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += String(chunk);
    const line = data.split(/\r?\n/)[0] ?? '';
    if (!line) throw new Error('no password on stdin');
    return line;
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n')
          return done(value ? undefined : new Error('no password entered'));
        if (c === '\u0003') return done(new Error('cancelled'));
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Schema migrations without booting the application: the same connection options and migration
 * list as the app (`database/typeorm-options.ts`), each migration in its own transaction.
 */
async function database(cmd: 'db:migrate' | 'db:status' | 'db:revert', cfg: AppConfig) {
  const dataSource = new DataSource(
    buildDataSourceOptions(
      (key) => cfg[key as keyof AppConfig] as string | number | boolean | undefined,
    ),
  );
  await dataSource.initialize();
  try {
    if (cmd === 'db:migrate') {
      const applied = await dataSource.runMigrations({ transaction: 'each' });
      process.stdout.write(
        applied.length
          ? `applied ${applied.length} migration(s):\n${applied.map((m) => `  ${m.name}`).join('\n')}\n`
          : 'database is up to date\n',
      );
    } else if (cmd === 'db:revert') {
      await dataSource.undoLastMigration({ transaction: 'each' });
      process.stdout.write('reverted the most recent migration\n');
    } else {
      const runner = dataSource.createQueryRunner();
      const executed = new Set(
        (await runner.hasTable('migrations'))
          ? (
              (await dataSource.query(`SELECT name FROM migrations ORDER BY id`)) as Array<{
                name: string;
              }>
            ).map((r) => r.name)
          : [],
      );
      await runner.release();
      const names = dataSource.migrations.map((m) => m.name ?? m.constructor.name);
      for (const name of names)
        process.stdout.write(`  [${executed.has(name) ? 'x' : ' '}] ${name}\n`);
      const pending = names.filter((n) => !executed.has(n)).length;
      process.stdout.write(
        pending ? `${pending} pending: run \`npm run db:migrate\`\n` : 'database is up to date\n',
      );
      if (pending) process.exitCode = 1;
    }
  } finally {
    await dataSource.destroy();
  }
}

/** Human-readable calculation trace (PDF p.20 #2). */
function renderTrace(t: Record<string, unknown>): string {
  const r = t.record as Record<string, unknown>;
  const cur = t.current as { label: string; formula: string; status: string };
  const daily = t.daily as {
    asOfDate: string;
    latestCompletedDate: string;
    used: Array<{
      dateUtc: string;
      volumeUsd: string | null;
      marketCapUsd: string | null;
      vmc: string | null;
      closeUsd: string | null;
      valid: boolean | null;
      revision: number | null;
      invalidReasons: string[];
    }>;
  };
  const windows = t.windows as Array<{
    days: number;
    role: string;
    formula: string;
    comparison: string | null;
  }>;
  const elig = t.eligibility as {
    status: string;
    reasons: string[];
    assetClass: string;
    classSource: string;
  };
  const lb = t.lbank as {
    status: string;
    reason: string | null;
    pairs: Array<{ marketPair: string; mapping: string; trading: string }>;
  };
  const batch = t.batch as {
    id: string;
    slotTime: string;
    crawledAt: string;
    status: string;
    isLive: boolean;
  };
  const lines = [
    `${r.symbol} · ${r.name} · CMC id ${r.cmcId}${batch.isLive ? '' : '   [SYNTHETIC fixture data]'}`,
    `batch ${batch.id} · slot ${batch.slotTime} · crawled ${batch.crawledAt} · ${batch.status}`,
    `rank ${r.rank ?? 'n/a'} · cap ${r.capUsd ?? 'n/a'} USD · volume 24h ${r.volume24hUsd ?? 'n/a'} USD · price ${r.priceUsd ?? 'n/a'} USD · age ${r.ageDays ?? 'n/a'} days`,
    '',
    `Current observation (${cur.status}): ${cur.label}`,
    `  ${cur.formula}`,
    '',
    `Completed UTC daily rows used (as-of ${daily.asOfDate}; newest = ${daily.latestCompletedDate}):`,
    '  date        volume_usd            market_cap_usd          vmc                      close        rev',
    ...daily.used.map(
      (d) =>
        `  ${d.dateUtc}  ${(d.volumeUsd ?? '—').padEnd(20)}  ${(d.marketCapUsd ?? '—').padEnd(22)}  ${(d.vmc ?? (d.valid === false ? `invalid: ${d.invalidReasons.join(',')}` : 'missing')).slice(0, 24).padEnd(24)} ${(d.closeUsd ?? '—').slice(0, 12).padEnd(12)} ${d.revision ?? '-'}`,
    ),
    '',
    'Windows:',
    ...windows.flatMap((w) => [
      `  ${w.days}d (${w.role})`,
      `    ${w.formula}`,
      ...(w.comparison ? [`    ${w.comparison}`] : []),
    ]),
    '',
    `Stars ${r.stars} · eligibility ${elig.status}${elig.reasons.length ? ` (${elig.reasons.join(', ')})` : ''} · class ${elig.assetClass} [${elig.classSource}]`,
    `LBank ${lb.status}${lb.reason ? ` (${lb.reason})` : ''}: ${lb.pairs.map((p) => `${p.marketPair} ${p.mapping}/${p.trading}`).join('; ') || 'no pairs'}`,
    `queue ${r.inQueue ? `#${r.queueOrder}` : 'no'} · flags ${[...(r.flags as string[]), ...(r.venueFlags as string[])].join(', ') || 'none'}`,
    `ruleset ${r.rulesetVersion} · config ${r.configVersion} · inputs ${r.inputsHash} · computed ${r.computedAt}`,
  ];
  return lines.join('\n');
}

function fakePreview(tz: string): string[] {
  const now = new Date();
  return formatTier1Report({
    generatedAt: now,
    slotTime: slotOf(now),
    crawledAt: now,
    timezone: tz,
    providerName: 'Fake preview data (NOT real)',
    isLive: false,
    attribution: null,
    batchStatus: 'COMPLETE',
    batchReasons: [],
    queueStatus: 'PUBLISHED',
    counts: { assets: 8041, eligible: 212, needsReview: 341, excluded: 7488, queue: 2 },
    needsReviewWithYes: 14,
    lbankUnverifiedWithYes: 11,
    rows: [
      {
        order: 1,
        cmcId: 990001,
        symbol: 'FAKE1',
        stars: 2,
        pass: { d3: 'YES', d7: 'NO', d30: 'YES' },
        multiple: { d3: 2, d7: 1.333, d30: 4 },
        currentVmc: 0.2,
        capUsd: 1e8,
        lbankPairs: ['FAKE1/USDT'],
      },
      {
        order: 2,
        cmcId: 990002,
        symbol: 'FAKE2',
        stars: 1,
        pass: { d3: 'NO', d7: 'N/A', d30: 'YES' },
        multiple: { d3: 1.2, d7: null, d30: 1.9 },
        currentVmc: 0.031,
        capUsd: 4e7,
        lbankPairs: ['FAKE2/USDT', 'FAKE2/BTC'],
      },
    ],
    warnings: [],
  });
}

main().catch((err) => {
  process.stderr.write(`${redact(err instanceof Error ? err.message : String(err))}\n`);
  process.exit(1);
});
