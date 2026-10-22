import { log } from '../log';
import { claudeRuntime } from './claude';
import { devinCloudRuntime } from './devinCloud';
import { devinLocalRuntime } from './devinLocal';
import { registerRuntime, setRuntimeLogger } from './runtime';

setRuntimeLogger((event, detail) => log('shell', event, { detail }));
registerRuntime(devinCloudRuntime);
registerRuntime(devinLocalRuntime);
registerRuntime(claudeRuntime);

export { disposeAll, runtimeFor, runtimes } from './runtime';
export type { ProviderRuntime } from './runtime';
