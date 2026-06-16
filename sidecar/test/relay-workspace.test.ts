import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeRelayWorkspaceContext,
  relayWorkspaceSourcePayload,
} from '../src/relay-workspace';

describe('relay workspace metadata', () => {
  it('normalizes the canonical workspace metadata key', () => {
    assert.deepEqual(
      normalizeRelayWorkspaceContext({ relay_workspace_id: ' workspace-19 ' }),
      { relay_workspace_id: 'workspace-19' },
    );
  });

  it('omits metadata when no workspace is signed in', () => {
    assert.deepEqual(normalizeRelayWorkspaceContext({}), {});
    assert.deepEqual(relayWorkspaceSourcePayload({}), {});
  });

  it('stamps Recall create-upload source metadata with relay_workspace_id', () => {
    assert.deepEqual(
      relayWorkspaceSourcePayload({ relay_workspace_id: 'workspace-a' }),
      { source: { relay_workspace_id: 'workspace-a' } },
    );
  });
});
