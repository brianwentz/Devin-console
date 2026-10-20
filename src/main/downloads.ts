import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { dialog } from 'electron';
import { log } from './log';
import { state } from './state';

export function setupDownloads(githubSession: Electron.Session): void {
  githubSession.on('will-download', (_event, item, webContents) => {
    const url = item.getURL();
    const filename = basename(item.getFilename().replace(/[\\/:*?"<>|]/g, '_'));
    const directory = process.env.AGENT_WORKSPACE_DOWNLOAD_DIR;
    log('gh:download', 'download-start', {
      url,
      decision: directory ? 'configured-directory' : 'save-dialog',
      detail: { filename, webContentsId: webContents.id },
    });
    if (directory) {
      mkdirSync(resolve(directory), { recursive: true });
      item.setSavePath(join(resolve(directory), filename || 'download'));
    } else {
      const options = { defaultPath: filename || 'download' };
      const prompt = state.windowRef
        ? dialog.showSaveDialog(state.windowRef, options)
        : dialog.showSaveDialog(options);
      void prompt.then((result) => {
        if (result.canceled || !result.filePath) {
          item.cancel();
          log('gh:download', 'download-cancel', { url, decision: 'cancelled' });
        } else {
          item.setSavePath(result.filePath);
        }
      });
    }
    item.on('updated', (_downloadEvent, downloadState) => {
      log('gh:download', 'download-progress', {
        url,
        detail: {
          state: downloadState,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
        },
      });
    });
    item.once('done', (_downloadEvent, downloadState) => {
      log('gh:download', 'download-done', {
        url,
        decision: downloadState,
        detail: { path: item.getSavePath() },
      });
    });
  });
}
