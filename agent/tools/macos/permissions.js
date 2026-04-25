import { resolveMacOSBackend } from './helper-client.js';

export function getMacOSCapabilityReport() {
  const backend = resolveMacOSBackend();
  return {
    backend: backend.type,
    helperPath: backend.helperPath || '',
    helperAvailable: Boolean(backend.helperPath),
    features: backend.type === 'helper'
      ? ['observe', 'open_app', 'activate_app', 'type_text', 'press_key', 'click_at']
      : ['observe', 'open_app', 'activate_app'],
  };
}
