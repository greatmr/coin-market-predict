/** The chat's message limit: user messages that count in one conversation. Pure. */
export interface ChatQuota {
  max: number;
  used: number;
  remaining: number;
}

export function chatQuota(used: number, max: number): ChatQuota {
  return { max, used, remaining: Math.max(0, max - used) };
}
