import { useState } from 'react';
import type { ChatSessionPublic } from '../../shared/ipc';
import { Markdown } from '../local/Markdown';

type ToolCall = ChatSessionPublic['toolCalls'][string];

export const buttonClass =
  'px-2.5 py-1 rounded-md border border-[#39475a] bg-[#1a2330] hover:bg-[#2a394d] text-xs disabled:hover:bg-[#1a2330]';

const statusColor: Record<ToolCall['status'], string> = {
  pending: 'text-[#aeb9c8]',
  in_progress: 'text-[#83b6ff]',
  completed: 'text-[#8fd18f]',
  failed: 'text-[#ff8a8a]',
};

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ThoughtBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thought my-1 rounded-md border border-dashed border-[#39475a] bg-[#0d141d]/60 text-xs">
      <button
        type="button"
        className="thought-toggle w-full text-left px-2 py-1 text-[#7f8ca0] hover:text-[#aeb9c8]"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Thinking
      </button>
      {open && (
        <div className="thought-body px-2 pb-2 text-[#aeb9c8] whitespace-pre-wrap">{text}</div>
      )}
    </div>
  );
}

export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const raw =
    call.rawInput !== undefined || call.rawOutput !== undefined || (call.content?.length ?? 0) > 0;
  return (
    <div
      className="tool-call my-1.5 rounded-md border border-[#39475a] bg-[#0d141d] text-xs"
      data-tool-call-id={call.id}
      data-status={call.status}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="tool-kind rounded bg-[#1a2330] px-1.5 py-0.5 font-mono text-[10px] uppercase text-[#aeb9c8]">
          {call.kind ?? 'tool'}
        </span>
        <span className="tool-title flex-1 truncate text-[#e8edf5]">{call.title}</span>
        <span className={`tool-status font-mono ${statusColor[call.status]}`}>{call.status}</span>
        {raw && (
          <button
            type="button"
            className="tool-toggle text-[#7f8ca0] hover:text-[#e8edf5]"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '▾' : '▸'}
          </button>
        )}
      </div>
      {call.locations && call.locations.length > 0 && (
        <div className="px-2 pb-1 font-mono text-[10px] text-[#7f8ca0]">
          {call.locations.map((location, index) => (
            <div key={`${location.path}:${index}`}>
              {location.path}
              {location.line != null ? `:${location.line}` : ''}
            </div>
          ))}
        </div>
      )}
      {open && raw && (
        <pre className="tool-raw m-0 max-h-64 overflow-auto border-t border-[#39475a] px-2 py-1.5 font-mono text-[11px] text-[#aeb9c8] whitespace-pre-wrap">
          {call.rawInput !== undefined && `input:\n${safeJson(call.rawInput)}\n`}
          {call.content && call.content.length > 0 && `content:\n${safeJson(call.content)}\n`}
          {call.rawOutput !== undefined && `output:\n${safeJson(call.rawOutput)}`}
        </pre>
      )}
    </div>
  );
}

const planMark: Record<NonNullable<ChatSessionPublic['plan']>[number]['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
};

export function PlanList({ plan }: { plan: NonNullable<ChatSessionPublic['plan']> }) {
  return (
    <div className="plan rounded-md border border-[#39475a] bg-[#0d141d] px-3 py-2 text-xs">
      <div className="mb-1 text-[#7f8ca0] uppercase tracking-wide text-[10px]">Plan</div>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {plan.map((entry, index) => (
          <li
            key={`${index}-${entry.content}`}
            className="plan-entry flex items-start gap-2"
            data-status={entry.status}
          >
            <span
              className={
                entry.status === 'completed'
                  ? 'text-[#8fd18f]'
                  : entry.status === 'in_progress'
                    ? 'text-[#83b6ff]'
                    : 'text-[#7f8ca0]'
              }
            >
              {planMark[entry.status]}
            </span>
            <span className={entry.status === 'completed' ? 'text-[#aeb9c8] line-through' : ''}>
              {entry.content}
            </span>
            <span className="ml-auto font-mono text-[10px] text-[#7f8ca0]">{entry.priority}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PermissionCard({
  permission,
  onRespond,
}: {
  permission: NonNullable<ChatSessionPublic['pendingPermission']>;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <div
      className="permission-card rounded-md border border-[#e0a03c] bg-[#1d1a12] px-3 py-2 text-xs"
      data-request-id={permission.requestId}
    >
      <div className="mb-1 text-[#e0a03c] uppercase tracking-wide text-[10px]">Permission required</div>
      <div className="mb-2 text-[#e8edf5]">{permission.title}</div>
      <div className="flex flex-wrap gap-2">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={`permission-option ${buttonClass}`}
            data-option-id={option.optionId}
            data-kind={option.kind}
            disabled={chosen !== null}
            onClick={() => {
              setChosen(option.optionId);
              onRespond(permission.requestId, option.optionId);
            }}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function MessageView({
  message,
  session,
}: {
  message: ChatSessionPublic['messages'][number];
  session: ChatSessionPublic;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`msg msg-${message.role} flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-[#27364a] text-[#e8edf5]' : 'bg-[#18212e] text-[#e8edf5]'
        }`}
      >
        {message.blocks.map((block, index) => {
          if (block.type === 'text') {
            return isUser ? (
              <div key={index} className="whitespace-pre-wrap">
                {block.text}
              </div>
            ) : (
              <Markdown key={index} text={block.text} />
            );
          }
          if (block.type === 'thought') return <ThoughtBlock key={index} text={block.text} />;
          const call = session.toolCalls[block.id];
          return call ? <ToolCallCard key={index} call={call} /> : null;
        })}
      </div>
    </div>
  );
}
