export type CapabilityMethod = 'GET' | 'POST';

export interface CapabilityDefinition {
  method: CapabilityMethod;
  path: string;
  params: Record<string, 'string'>;
}

export const CAPABILITY_REGISTRY = {
  'data.recordings': {
    method: 'GET',
    path: '/recordings',
    params: {},
  },
  'data.transcript': {
    method: 'GET',
    path: '/recordings/transcript',
    params: { sessionId: 'string' },
  },
  'data.transcriptSearch': {
    method: 'GET',
    path: '/recordings/search',
    params: { query: 'string' },
  },
  'recorder.status': {
    method: 'GET',
    path: '/status',
    params: {},
  },
} as const satisfies Record<string, CapabilityDefinition>;

export type CapabilityKey = keyof typeof CAPABILITY_REGISTRY;

export const CAPABILITY_KEYS: ReadonlySet<string> = new Set(Object.keys(CAPABILITY_REGISTRY));
