import { log } from '../log';
import { claudeRuntime } from './claude';
import { devinCloudRuntime } from './devinCloud';
import { devinLocalRuntime } from './devinLocal';
import { openhandsRuntime } from './openhands';
import { registerRuntime, setRuntimeLogger } from './runtime';

setRuntimeLogger((event, detail) => log('shell', event, { detail }));
registerRuntime(devinCloudRuntime);
registerRuntime(devinLocalRuntime);
registerRuntime(claudeRuntime);
registerRuntime(openhandsRuntime);

export { disposeAll, runtimeFor, runtimes } from './runtime';
export type { ProviderRuntime } from './runtime';
