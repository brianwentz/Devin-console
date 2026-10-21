import { dialog } from 'electron';
import { testMode } from './state';

// Every folder picker goes through openFolderDialog so tests can see the
// options (lastOpenDialogOptions hook) and force a cancel
// (AGENT_WORKSPACE_TEST_PICKER_CANCEL=1) without a modal ever opening.
let lastOptions: Electron.OpenDialogOptions | null = null;

export function lastOpenDialogOptions(): Electron.OpenDialogOptions | null {
  return lastOptions;
}

export async function openFolderDialog(
  win: Electron.BaseWindow,
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  if (testMode) lastOptions = { ...options };
  if (testMode && process.env.AGENT_WORKSPACE_TEST_PICKER_CANCEL === '1') {
    return { canceled: true, filePaths: [] };
  }
  return dialog.showOpenDialog(win, options);
}
