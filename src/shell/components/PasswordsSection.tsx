import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { normalizeOrigin, SUGGESTED_ORIGINS, type CredentialEntry } from '../../core/credentials';

const inputClass =
  'w-full max-w-md px-2 py-1.5 rounded-md border border-[#39475a] bg-[#0d141d] text-sm text-[#e8edf5]';
const saveClass =
  'px-3 py-1.5 rounded-md border border-[#39475a] bg-[#1a2330] hover:bg-[#2a394d] text-sm disabled:hover:bg-[#1a2330]';
const rowButtonClass =
  'px-2 py-1 rounded-md border border-[#39475a] bg-[#1a2330] hover:bg-[#2a394d] text-xs disabled:hover:bg-[#1a2330]';

const REVEAL_MS = 30_000;
const CONFIRM_DELETE_MS = 3_000;

function relativeLastUsed(lastUsedAt: number | null): string {
  if (lastUsedAt === null) return 'never';
  const delta = Date.now() - lastUsedAt;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function PasswordRow({ entry }: { entry: CredentialEntry }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editUsername, setEditUsername] = useState(entry.username);
  const [editPassword, setEditPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const show = async () => {
    const value = await window.agentworkspace.revealCredential(entry.id);
    if (value === null) {
      setError('Could not decrypt this password');
      return;
    }
    setError(null);
    setRevealed(value);
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => setRevealed(null), REVEAL_MS);
  };

  const hide = () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    setRevealed(null);
  };

  const copy = async () => {
    const value = revealed ?? (await window.agentworkspace.revealCredential(entry.id));
    if (value === null) {
      setError('Could not decrypt this password');
      return;
    }
    await navigator.clipboard.writeText(value);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2_000);
  };

  const saveEdit = async () => {
    const patch: { username?: string; password?: string } = {};
    if (editUsername && editUsername !== entry.username) patch.username = editUsername;
    if (editPassword) patch.password = editPassword;
    const result = await window.agentworkspace.updateCredential(entry.id, patch);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setEditing(false);
    setEditPassword('');
  };

  const remove = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      deleteTimer.current = setTimeout(() => setConfirmDelete(false), CONFIRM_DELETE_MS);
      return;
    }
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
    void window.agentworkspace.deleteCredential(entry.id);
  };

  return (
    <>
      <tr data-credential-id={entry.id} className="border-b border-[#39475a]/60 hover:bg-[#1a2330]">
        <td className="px-2 py-1.5 align-middle">
          <span className="font-mono text-xs truncate max-w-[16rem] block" title={entry.origin}>
            {entry.origin}
          </span>
        </td>
        <td className="px-2 py-1.5 align-middle">
          {editing ? (
            <input
              id={`credentialEditUsername-${entry.id}`}
              className={inputClass}
              value={editUsername}
              onChange={(event) => setEditUsername(event.target.value)}
              placeholder="Username"
              autoComplete="off"
            />
          ) : (
            <span className="font-mono text-xs">{entry.username}</span>
          )}
        </td>
        <td className="px-2 py-1.5 align-middle">
          {editing ? (
            <input
              id={`credentialEditPassword-${entry.id}`}
              className={inputClass}
              type="password"
              value={editPassword}
              onChange={(event) => setEditPassword(event.target.value)}
              placeholder="New password (unchanged if blank)"
              autoComplete="off"
            />
          ) : revealed !== null ? (
            <input
              className={inputClass}
              readOnly
              value={revealed}
              aria-label="Revealed password"
              onBlur={hide}
            />
          ) : (
            <span className="text-[#7f8ca0]">••••••••</span>
          )}
        </td>
        <td className="px-2 py-1.5 align-middle text-xs text-[#7f8ca0]">
          {relativeLastUsed(entry.lastUsedAt)}
        </td>
        <td className="px-2 py-1.5 align-middle text-right whitespace-nowrap">
          <span className="flex justify-end gap-1">
            {editing ? (
              <>
                <button
                  id={`credentialEditSave-${entry.id}`}
                  type="button"
                  className={rowButtonClass}
                  onClick={() => void saveEdit()}
                >
                  Save
                </button>
                <button type="button" className={rowButtonClass} onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  id={`credentialReveal-${entry.id}`}
                  type="button"
                  className={rowButtonClass}
                  aria-label={revealed === null ? 'Show password' : 'Hide password'}
                  onClick={() => (revealed === null ? void show() : hide())}
                >
                  {revealed === null ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button
                  id={`credentialCopy-${entry.id}`}
                  type="button"
                  className={rowButtonClass}
                  onClick={() => void copy()}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  id={`credentialEdit-${entry.id}`}
                  type="button"
                  className={rowButtonClass}
                  onClick={() => {
                    setEditing((value) => !value);
                    setEditUsername(entry.username);
                    setEditPassword('');
                    setError(null);
                  }}
                >
                  Edit
                </button>
                <button
                  id={`credentialDelete-${entry.id}`}
                  type="button"
                  className={rowButtonClass}
                  onClick={remove}
                >
                  {confirmDelete ? 'Confirm delete' : 'Delete'}
                </button>
              </>
            )}
          </span>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={5} className="text-xs text-[#ff8a8a] px-2 pb-1.5">
            {error}
          </td>
        </tr>
      )}
    </>
  );
}

export function PasswordsSection({
  credentials,
  tenantUrl,
}: {
  credentials: CredentialEntry[];
  tenantUrl: string;
}) {
  const tenantOrigin = normalizeOrigin(tenantUrl);
  const originOptions = [...SUGGESTED_ORIGINS, ...(tenantOrigin ? [tenantOrigin] : [])];
  const [originChoice, setOriginChoice] = useState(originOptions[0] ?? 'custom');
  const [customOrigin, setCustomOrigin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const save = () => {
    const raw = originChoice === 'custom' ? customOrigin : originChoice;
    const origin = normalizeOrigin(raw);
    if (!origin) {
      setError('Origin must be a valid https:// origin');
      return;
    }
    if (!username || !password) {
      setError('Username and password are required');
      return;
    }
    setError(null);
    void window.agentworkspace
      .saveCredential({ origin, username, password })
      .then((result) => {
        if (!result.ok) setError(result.error);
        else {
          setUsername('');
          setPassword('');
        }
      });
  };

  const query = search.trim().toLowerCase();
  const visible = credentials.filter(
    (entry) =>
      !query ||
      entry.origin.toLowerCase().includes(query) ||
      entry.username.toLowerCase().includes(query),
  );
  const sorted = [...visible].sort(
    (a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username),
  );

  return (
    <section id="credentialsSection" className="flex flex-col gap-3">
      <p className="text-xs text-[#7f8ca0] max-w-md">
        Saved passwords are filled automatically in GitHub tabs and the Devin view. Stored
        encrypted with the OS keychain (Windows DPAPI / macOS Keychain).
      </p>
      {credentials.length > 5 && (
        <input
          id="credentialSearch"
          className={inputClass}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search passwords"
          autoComplete="off"
        />
      )}
      {credentials.length === 0 ? (
        <p id="credentialsEmpty" className="text-xs text-[#7f8ca0]">
          No saved passwords yet.
        </p>
      ) : (
        <table id="credentialsTable" className="w-full max-w-3xl text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left text-xs font-semibold text-[#7f8ca0] border-b border-[#39475a] px-2 py-1.5">
                Origin
              </th>
              <th className="text-left text-xs font-semibold text-[#7f8ca0] border-b border-[#39475a] px-2 py-1.5">
                Username
              </th>
              <th className="text-left text-xs font-semibold text-[#7f8ca0] border-b border-[#39475a] px-2 py-1.5">
                Password
              </th>
              <th className="text-left text-xs font-semibold text-[#7f8ca0] border-b border-[#39475a] px-2 py-1.5">
                Last used
              </th>
              <th className="text-right text-xs font-semibold text-[#7f8ca0] border-b border-[#39475a] px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-1.5 text-xs text-[#7f8ca0]">
                  No matches.
                </td>
              </tr>
            ) : (
              sorted.map((entry) => <PasswordRow key={entry.id} entry={entry} />)
            )}
          </tbody>
        </table>
      )}
      <div className="flex flex-col gap-2 max-w-md">
        <select
          id="credentialOrigin"
          className={inputClass}
          value={originChoice}
          onChange={(event) => setOriginChoice(event.target.value)}
        >
          {originOptions.map((origin) => (
            <option key={origin} value={origin}>
              {origin}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        {originChoice === 'custom' && (
          <input
            id="credentialOriginCustom"
            className={inputClass}
            value={customOrigin}
            onChange={(event) => setCustomOrigin(event.target.value)}
            placeholder="https://login.example.com"
          />
        )}
        <input
          id="credentialUsername"
          className={inputClass}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Username"
          autoComplete="off"
        />
        <input
          id="credentialPassword"
          className={inputClass}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          autoComplete="off"
        />
        <div className="flex items-center gap-3">
          <button id="credentialSave" type="button" className={saveClass} onClick={save}>
            Add password
          </button>
          {error && <span className="text-sm text-[#ff8a8a]">{error}</span>}
        </div>
      </div>
      <p className="text-xs text-[#7f8ca0] max-w-md">
        Sign-in tips: Prefer passkeys — enroll a passkey (Windows Hello) at Okta and GitHub for
        one-prompt sign-in.
      </p>
    </section>
  );
}
