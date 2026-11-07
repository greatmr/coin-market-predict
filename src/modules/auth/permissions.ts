/**
 * Dashboard roles and what each may see and do. Pure data: the HTTP guard, the dashboard and the
 * tests all read this one table, so a permission never means two different things.
 *
 *  - owner     everything, including user management and the Telegram audience (personal chat ids)
 *  - analyzer  every data page, run health and exports; operates the screen (reprocess a batch,
 *              refresh the LBank list) but records no human decisions
 *  - reviewer  the market pages and coin details; records reviews and LBank decisions, nothing
 *              operational, no bulk exports, no run health
 */
export const USER_ROLES = ['owner', 'analyzer', 'reviewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PERMISSIONS = [
  /** Overview, the four sheets, coin details, snapshots, coin search, the LBank list status. */
  'data:read',
  /** Crawl batches, pipeline runs, source health, open mapping tasks. */
  'health:read',
  /** Download the CSV / XLSX exports (bulk data). */
  'exports:read',
  /** Save review revisions and LBank venue decisions (append-only human records). */
  'review:write',
  /** Reprocess the latest batch and refresh the LBank Spot list (no crawling of new hours). */
  'scan:operate',
  /** Telegram members, pending requests, missed reports and re-sends. */
  'telegram:manage',
  /** Create, change, reset and delete dashboard users. */
  'users:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  owner: PERMISSIONS,
  analyzer: ['data:read', 'health:read', 'exports:read', 'scan:operate'],
  reviewer: ['data:read', 'review:write'],
};

export const can = (role: UserRole, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);

export const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  owner: 'Owner',
  analyzer: 'Analyzer',
  reviewer: 'Reviewer',
};
