/**
 * Claude chat (docs/adr/0012-owner-chat.md): an owner-only, read-only conversation with the
 * "analyst desk". Value sets of the PostgreSQL enum types of migration M019.
 */

/** Version of the chat's instructions and tools; stored on every reply. */
export const CHAT_PROMPT_VERSION = 'desk-chat-1';

export const CHAT_ROLES = ['user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export const CHAT_MESSAGE_STATUSES = ['DONE', 'RUNNING', 'FAILED'] as const;
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];

/** Models the owner can pick. `effort: false` = the model has no effort setting. */
export const CHAT_MODELS = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2', note: 'Most capable, slowest', effort: true },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'Deep analysis', effort: true },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'Fast and balanced', effort: true },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: 'Quickest, light', effort: false },
] as const;
export const CHAT_MODEL_IDS = CHAT_MODELS.map((m) => m.id) as [string, ...string[]];

/** How hard Claude thinks before answering (the SDK's effort levels). */
export const CHAT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

export const CHAT_MESSAGE_MAX_CHARS = 4000;
/** Earlier turns sent with a new message; the oldest are dropped first. */
export const CHAT_HISTORY_MAX_CHARS = 24_000;

/** pg_advisory_xact_lock key serializing the limit check and the start of a reply. */
export const CHAT_LOCK_KEY = 4_100_100_002;

/** A reply still RUNNING this long after its timeout was lost (restart, crash). */
export const CHAT_STALE_GRACE_MS = 120_000;

export const chatModelHasEffort = (id: string) =>
  CHAT_MODELS.find((m) => m.id === id)?.effort ?? false;
