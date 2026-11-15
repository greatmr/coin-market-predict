// Payloads of /api/telegram/* (telegram-access.controller.ts, telegram/admin.service.ts).
import type { Iso } from '../../types/api';

export interface AccessRow {
  chatId: string;
  label: string;
  at: Iso | null;
}

/** GET /api/telegram/access */
export interface TelegramAccess {
  owner: string | null;
  mode: string;
  commandsEnabled: boolean;
  canManage: boolean;
  missingCount: number;
  members: AccessRow[];
  pending: AccessRow[];
  denied: string[];
}

export type DeliveryState = 'pending' | 'retrying' | 'gave_up' | 'not_queued';

export interface MissedDelivery {
  runId: string;
  slotTime: Iso;
  chatId: string;
  label: string;
  state: DeliveryState;
  partsSent: number;
  partCount: number;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Iso | null;
}

/** GET /api/telegram/missing */
export interface TelegramMissing {
  hours: number;
  mode: string;
  recipients: { chatId: string; label?: string }[];
  rows: MissedDelivery[];
}

/** POST /api/telegram/retry and /api/telegram/send */
export interface DeliveryResult {
  ok: boolean;
  reason?: string;
  queued?: number;
  requeued?: number;
  delivery: { sent: number; failed: number; deferred: number } | null;
}

/** POST /api/telegram/access/:action */
export interface AccessChangeResult {
  ok: boolean;
  notified?: boolean;
  removed?: boolean;
}
