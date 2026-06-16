export type RecorderMode = 'brainstorm' | 'meeting';

export interface AutomationSettings {
  create_linear_issues: boolean;
  create_github_issues: boolean;
  dispatch_enabled: boolean;
}

export interface RecorderSettings {
  mode: RecorderMode;
  automation_settings: AutomationSettings;
}

export const DEFAULT_SETTINGS: RecorderSettings = {
  mode: 'brainstorm',
  automation_settings: {
    create_linear_issues: false,
    create_github_issues: false,
    dispatch_enabled: false,
  },
};

export function parseBoolean(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function normalizeMode(raw: unknown): RecorderMode {
  return raw === 'meeting' ? 'meeting' : DEFAULT_SETTINGS.mode;
}

export function normalizeAutomationSettings(raw: unknown): AutomationSettings {
  const input = raw && typeof raw === 'object' ? (raw as Partial<AutomationSettings>) : {};
  return {
    create_linear_issues: Boolean(input.create_linear_issues),
    create_github_issues: Boolean(input.create_github_issues),
    dispatch_enabled: Boolean(input.dispatch_enabled),
  };
}

export function normalizeRecorderSettings(raw: unknown): RecorderSettings {
  const input = raw && typeof raw === 'object' ? (raw as Partial<RecorderSettings>) : {};
  return {
    mode: normalizeMode(input.mode),
    automation_settings: normalizeAutomationSettings(input.automation_settings),
  };
}
