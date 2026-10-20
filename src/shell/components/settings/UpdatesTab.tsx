import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import type { ReleaseNotes, ReleaseNotesReply, ShellState } from '../../../shared/ipc';
import { Markdown } from '../Markdown';
import { saveClass } from './styles';

type NotesState = 'loading' | 'ok' | 'missing' | 'error';

function openExternal(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  const href = event.currentTarget.getAttribute('href');
  if (href) window.agentworkspace.openLink(href);
}

function NotesCard({
  id,
  title,
  notes,
  state,
}: {
  id: string;
  title: string;
  notes: ReleaseNotes | null;
  state: NotesState;
}) {
  const published = notes?.publishedAt ? new Date(notes.publishedAt) : null;
  return (
    <section
      id={id}
      data-notes-state={state}
      className="flex flex-col gap-2 max-w-2xl px-3 py-3 rounded-md border border-[#39475a] bg-[#0d141d] text-sm"
    >
      <div className="flex items-baseline gap-3">
        <span className="text-[#e8edf5]">{title}</span>
        {notes?.name && <span className="text-xs text-[#aeb9c8]">{notes.name}</span>}
        {published && !Number.isNaN(published.getTime()) && (
          <span className="text-xs text-[#7f8ca0]">{published.toLocaleDateString()}</span>
        )}
        {notes && (
          <a
            href={notes.htmlUrl}
            onClick={openExternal}
            className="ml-auto text-xs text-[#7f9dc8] hover:underline"
          >
            View on GitHub
          </a>
        )}
      </div>
      {state === 'loading' && <p className="text-xs text-[#7f8ca0]">Loading…</p>}
      {state === 'ok' && notes && <Markdown text={notes.body} />}
      {state === 'missing' && <p className="text-xs text-[#7f8ca0]">Release notes unavailable.</p>}
      {state === 'error' && <p className="text-xs text-[#ff8a8a]">Release notes unavailable.</p>}
    </section>
  );
}

export function UpdatesTab({ update }: { update: ShellState['update'] | null }) {
  const [reply, setReply] = useState<ReleaseNotesReply | null>(null);
  const [failed, setFailed] = useState(false);
  const availableVersion = update?.available ?? null;

  // On-demand check when the tab opens (throttled main-side to 60 s).
  useEffect(() => {
    window.agentworkspace.updateCheck('settings');
  }, []);

  useEffect(() => {
    let alive = true;
    setReply(null);
    setFailed(false);
    window.agentworkspace
      .releaseNotes()
      .then((result) => {
        if (alive) setReply(result);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [availableVersion]);

  if (!update) {
    return <p className="text-sm text-[#7f8ca0]">Version unavailable</p>;
  }

  const cardState = (notes: ReleaseNotes | null): NotesState =>
    failed ? 'error' : reply === null ? 'loading' : notes ? 'ok' : 'missing';

  return (
    <div className="flex flex-col gap-4">
      <section id="aboutSection" className="flex flex-col gap-2 text-sm">
        <p className="text-[#aeb9c8]">
          Version <span id="appVersion" className="font-mono text-[#e8edf5]">{update.version}</span>
        </p>
        {update.downloaded ? (
          <div
            id="updateStatus"
            data-update-state="ready"
            className="flex items-center gap-3 px-3 py-2 rounded-md border border-[#39475a] bg-[#1a2330]"
          >
            <span>Update v{update.downloaded} is ready to install.</span>
            <button
              id="updateNow"
              type="button"
              className={saveClass}
              onClick={() => window.agentworkspace.updateInstall()}
            >
              Update now
            </button>
          </div>
        ) : update.available ? (
          <p id="updateStatus" data-update-state="downloading" className="text-xs text-[#7f8ca0]">
            Update v{update.available} available — downloading…
          </p>
        ) : (
          <p id="updateStatus" data-update-state="none" className="text-xs text-[#7f8ca0]">
            You&apos;re up to date.
          </p>
        )}
        {!update.downloaded &&
          (update.enabled ? (
            <div className="flex items-center gap-3">
              <button
                id="updateCheckNow"
                type="button"
                className={saveClass}
                disabled={update.checking}
                onClick={() => window.agentworkspace.updateCheck('manual')}
              >
                {update.checking ? 'Checking…' : 'Check now'}
              </button>
              <span id="updateLastChecked" className="text-xs text-[#7f8ca0]">
                {update.checking
                  ? 'Checking…'
                  : update.lastCheckedAt
                    ? `Last checked ${new Date(update.lastCheckedAt).toLocaleTimeString()}`
                    : 'Not checked yet'}
              </span>
            </div>
          ) : (
            <span id="updateLastChecked" className="text-xs text-[#7f8ca0]">
              Automatic updates are unavailable in this build.
            </span>
          ))}
        {update.error && (
          <p id="updateError" className="text-xs text-[#ff8a8a]">
            Update check failed: {update.error}
          </p>
        )}
        <a
          id="releasesLink"
          href={update.releasesUrl}
          onClick={openExternal}
          className="text-xs text-[#7f9dc8] hover:underline"
        >
          All releases on GitHub
        </a>
      </section>
      {update.available && (
        <NotesCard
          id="releaseNotesAvailable"
          title={`What's new in v${update.available}`}
          notes={reply?.available ?? null}
          state={cardState(reply?.available ?? null)}
        />
      )}
      <NotesCard
        id="releaseNotesCurrent"
        title={`v${update.version} — current version`}
        notes={reply?.current ?? null}
        state={cardState(reply?.current ?? null)}
      />
    </div>
  );
}
