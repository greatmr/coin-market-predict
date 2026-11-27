export interface ChatModel {
  id: string;
  label: string;
  note: string;
  effort: boolean;
}

export const CHAT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

export interface ChatStatus {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  models: ChatModel[];
  defaultModel: string;
  defaultEffort: ChatEffort;
  maxMessages: number;
  promptVersion: string;
  strategy: { fingerprint: string; versions: Record<string, string> };
}

export interface ChatQuota {
  max: number;
  used: number;
  remaining: number;
}

export interface ChatMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  status: 'DONE' | 'RUNNING' | 'FAILED';
  content: string;
  model: string | null;
  effort: string | null;
  strategyVersion: string | null;
  toolCalls: { name: string; ok: boolean }[];
  errorKind: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  strategyVersion: string;
  currentStrategyVersion: string;
  strategyChanged: boolean;
  quota: ChatQuota;
  running: boolean;
  messages: ChatMessage[];
}

export interface ChatListItem {
  id: string;
  title: string;
  updatedAt: string;
  quota: ChatQuota;
}
