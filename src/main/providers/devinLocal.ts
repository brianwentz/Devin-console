import { providerById } from '../../core/providers';
import { localHost } from '../local/ipc';
import type { ProviderRuntime } from './runtime';

export const devinLocalRuntime: ProviderRuntime = {
  descriptor: providerById('devin-local'),
  // Local agents autostart from setupLocal()/acpHost, not from a provider start.
  start() {},
  async dispose() {
    localHost()?.dispose();
  },
};
