import { resolveMacOSBackend } from './helper-client.ts';

export function getMacOSCapabilityReport() {
  const backend = resolveMacOSBackend();
  return {
    backend: backend.type,
    helperPath: backend.helperPath || '',
    helperAvailable: Boolean(backend.helperPath),
    features: ['observe'],
  };
}
