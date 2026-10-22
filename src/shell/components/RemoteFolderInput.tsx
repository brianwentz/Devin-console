import { useEffect, useMemo, useRef, useState } from 'react';
import { TITLE_BAR_HEIGHT } from '../../core/layout';
import type { HostId } from '../../shared/ipc';
import { useShellState } from '../store';
import { inputClass } from './settings/styles';

// P3 — a path field with directory autocomplete for a remote host (WSL or
// SSH): suggestions come from `hosts:readdir` (the host helper's
// `fs.readdir`), never from Windows-side fs. Replaces the native folder
// dialog for every non-local host.

/** `/home/u/pr` → parent `/home/u/` + prefix `pr`; `/home/u/` → `/home/u/` + ''. */
export function splitRemotePath(path: string): { parent: string; prefix: string } {
  const at = path.lastIndexOf('/');
  if (at === -1) return { parent: '/', prefix: path };
  return { parent: path.slice(0, at + 1) || '/', prefix: path.slice(at + 1) };
}

export function RemoteFolderInput({
  hostId,
  value,
  onChange,
  onSubmit,
  autoFocus = false,
}: {
  hostId: HostId;
  value: string;
  onChange: (path: string) => void;
  onSubmit?: (path: string) => void;
  autoFocus?: boolean;
}) {
  const [names, setNames] = useState<{ parent: string; entries: string[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const { parent, prefix } = splitRemotePath(value);

  // One readdir per parent directory (debounced); typing within a directory filters locally.
  useEffect(() => {
    if (!value.startsWith('/')) {
      setNames(null);
      return;
    }
    if (names?.parent === parent) return;
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void window.agentworkspace.hostsReaddir(hostId, parent).then((result) => {
        if (mine !== seq.current) return;
        if (result.ok) {
          setError(null);
          setNames({ parent, entries: result.value.entries.map((e) => e.name), truncated: result.value.truncated });
        } else {
          setNames({ parent, entries: [], truncated: false });
          setError(result.error);
        }
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [hostId, parent, value, names?.parent]);

  // A host switch re-lists.
  useEffect(() => setNames(null), [hostId]);

  const options = useMemo(() => {
    if (!names || names.parent !== parent) return [];
    const showHidden = prefix.startsWith('.');
    return names.entries
      .filter((name) => name.startsWith(prefix) && (showHidden || !name.startsWith('.')))
      .slice(0, 50);
  }, [names, parent, prefix]);

  useEffect(() => setActive(-1), [parent, prefix]);

  const complete = (name: string) => onChange(`${parent}${name}/`);

  return (
    <div className="relative flex flex-col gap-1">
      <input
        id="remoteFolderInput"
        className={inputClass}
        value={value}
        spellCheck={false}
        autoFocus={autoFocus}
        aria-autocomplete="list"
        aria-controls="remoteFolderOptions"
        placeholder="/home/you/project"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && options.length) {
            event.preventDefault();
            setActive((i) => (i + 1) % options.length);
          } else if (event.key === 'ArrowUp' && options.length) {
            event.preventDefault();
            setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
          } else if (event.key === 'Tab' && options.length) {
            event.preventDefault();
            complete(options[Math.max(0, active)]!);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            if (active >= 0 && options[active]) complete(options[active]);
            else onSubmit?.(value);
          }
        }}
      />
      {options.length > 0 ? (
        <ul
          id="remoteFolderOptions"
          role="listbox"
          className="max-h-48 overflow-auto rounded border border-[#39475a] bg-[#0b111a] text-[12px]"
        >
          {options.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === active}
              data-remote-folder-option={`${parent}${name}`}
              className={`cursor-pointer px-2 py-1 ${i === active ? 'bg-[#243447] text-[#e8edf3]' : 'text-[#aeb9c8] hover:bg-[#1a2533]'}`}
              onMouseDown={(event) => {
                event.preventDefault();
                complete(name);
              }}
            >
              {name}/
            </li>
          ))}
        </ul>
      ) : null}
      {names?.truncated ? <span className="text-[11px] text-[#7f8ca0]">Showing the first entries only — keep typing.</span> : null}
      {error ? (
        <span id="remoteFolderError" className="text-[11px] text-[#d08080]">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Where the picked folder is stored: `ssh://<alias>/…` for ssh hosts, `<distro> · …` for WSL. */
const previewOf = (hostId: string, path: string): string =>
  hostId.startsWith('ssh:') ? `ssh://${hostId.slice(4)}${path}` : `${hostId.replace(/^wsl:/, '')} · ${path}`;

/** The host select's "This PC (browse…)" value — main continues in the native dialog. */
const LOCAL_CHOICE = 'local';

// The prompt main opens for a remote folder pick (ShellState.folderPrompt):
// host select + RemoteFolderInput; main raises the shell while it is open.
export function RemoteFolderPrompt() {
  const state = useShellState();
  const prompt = state?.folderPrompt ?? null;
  const [hostId, setHostId] = useState<HostId | null>(null);
  const [path, setPath] = useState('');

  // A new prompt resets the form to its host and start folder.
  useEffect(() => {
    if (!prompt) return;
    setHostId(prompt.hostId);
    setPath(prompt.start ? `${prompt.start.replace(/\/+$/, '')}/` : '/');
  }, [prompt?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!prompt) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.agentworkspace.folderPromptResolve(prompt.id, prompt.hostId, null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prompt]);

  if (!prompt || !hostId) return null;
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const valid = trimmed.startsWith('/') && !trimmed.includes('\\');
  const submit = (value: string) => {
    const target = value.length > 1 ? value.replace(/\/+$/, '') : value;
    if (!target.startsWith('/') || target.includes('\\')) return;
    window.agentworkspace.folderPromptResolve(prompt.id, hostId, target);
  };
  const cancel = () => window.agentworkspace.folderPromptResolve(prompt.id, prompt.hostId, null);

  return (
    <div
      id="remoteFolderBackdrop"
      className="absolute inset-0 z-50 bg-[#00000066]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <section
        id="remoteFolderPrompt"
        role="dialog"
        aria-label={prompt.title}
        className="absolute left-1/2 flex w-[520px] -translate-x-1/2 flex-col gap-3 rounded-lg border border-[#39475a] bg-[#101722] p-4 shadow-xl"
        style={{ top: TITLE_BAR_HEIGHT + 48 }}
      >
        <span className="text-[13px] font-semibold text-[#e8edf3]">{prompt.title}</span>
        <label className="flex items-center gap-2 text-[12px] text-[#aeb9c8]">
          <span>Host</span>
          <select
            id="remoteFolderHost"
            className={inputClass}
            value={hostId}
            onChange={(event) => {
              const next = event.target.value;
              if (next === LOCAL_CHOICE) {
                window.agentworkspace.folderPromptBrowse(prompt.id);
                return;
              }
              setHostId(next);
              const home = prompt.hosts.find((h) => h.id === next)?.home;
              setPath(home ? `${home.replace(/\/+$/, '')}/` : '/');
            }}
          >
            {prompt.hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.id.startsWith('ssh:') ? `SSH: ${host.label}` : `WSL: ${host.label}`}
              </option>
            ))}
            {prompt.browse ? <option value={LOCAL_CHOICE}>This PC (browse…)</option> : null}
          </select>
        </label>
        <RemoteFolderInput hostId={hostId} value={path} onChange={setPath} onSubmit={submit} autoFocus />
        {prompt.error ? (
          <span id="remoteFolderPromptError" role="alert" className="text-[11px] text-[#d08080]">
            {prompt.error}
          </span>
        ) : null}
        <span id="remoteFolderPreview" className="truncate text-[11px] text-[#7f8ca0]">
          {valid ? previewOf(hostId, trimmed) : 'Enter an absolute path'}
        </span>
        <div className="flex justify-end gap-2">
          <button id="remoteFolderCancel" type="button" className="text-[12px] text-[#aeb9c8]" onClick={cancel}>
            Cancel
          </button>
          <button
            id="remoteFolderConfirm"
            type="button"
            disabled={!valid}
            className="rounded bg-[#2f6fb5] px-3 py-1 text-[12px] text-white disabled:opacity-50"
            onClick={() => submit(path)}
          >
            Choose folder
          </button>
        </div>
      </section>
    </div>
  );
}
