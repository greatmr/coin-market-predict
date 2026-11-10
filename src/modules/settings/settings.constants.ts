/** Where a settings change came from (`setting_change_source`, migration M010). */
export const SETTING_CHANGE_SOURCES = ['dashboard', 'cli', 'import_env'] as const;
export type SettingChangeSource = (typeof SETTING_CHANGE_SOURCES)[number];
