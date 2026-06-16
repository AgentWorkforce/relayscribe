export const RELAY_WORKSPACE_METADATA_KEY = 'relay_workspace_id';

export interface RelayWorkspaceContext {
  relay_workspace_id?: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeRelayWorkspaceContext(raw: unknown): RelayWorkspaceContext {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const workspaceId =
    readNonEmptyString(input.relay_workspace_id) ??
    readNonEmptyString(input.relayWorkspaceId) ??
    readNonEmptyString(input.workspace_id) ??
    readNonEmptyString(input.workspaceId);
  return workspaceId ? { relay_workspace_id: workspaceId } : {};
}

export function relayWorkspaceSourcePayload(
  context: RelayWorkspaceContext,
): { source?: Record<string, string> } {
  return context.relay_workspace_id
    ? { source: { [RELAY_WORKSPACE_METADATA_KEY]: context.relay_workspace_id } }
    : {};
}
