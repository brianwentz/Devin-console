import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SidebarSession, SessionTreeNode } from '../../../core/sessionTree';
import { sessionMetaClass, sessionRowClass } from '../sessionRowStyles';
import { SESSION_MIME } from './dnd';

// Row render callbacks: everything surface-specific (status dot, unread/data
// attrs, meta content, open/menu behaviour) arrives through these.
export interface RowRenderOpts<S extends SidebarSession> {
  attrs: (s: S, variant: 'tree' | 'flat') => Record<string, unknown>;
  leading?: (s: S, variant: 'tree' | 'flat') => ReactNode;
  badges?: (s: S, variant: 'tree' | 'flat') => ReactNode;
  meta?: (s: S, variant: 'tree' | 'flat') => ReactNode;
  title?: (s: S) => string;
  titleClass?: (s: S, variant: 'tree' | 'flat') => string | undefined;
  rowClass?: (s: S, variant: 'tree' | 'flat') => string;
  onOpen: (id: string) => void;
  prefetch?: { onEnter: (id: string) => void; onLeave: () => void };
  hasChildren?: (node: SessionTreeNode<S>) => boolean;
}

export function SessionRowButton<S extends SidebarSession>({
  s,
  depth,
  current,
  registerRow,
  opts,
  onMenu,
  variant = 'flat',
}: {
  s: S;
  depth: number;
  current: boolean;
  registerRow: (el: HTMLButtonElement | null) => void;
  opts: RowRenderOpts<S>;
  onMenu: (sessionId: string, x: number, y: number) => void;
  variant?: 'tree' | 'flat';
}) {
  const isArchived = s.isArchived === true;
  return (
    <button
      type="button"
      ref={registerRow}
      data-session-id={s.id}
      data-depth={depth}
      data-current={current}
      {...opts.attrs(s, variant)}
      title={opts.title ? opts.title(s) : s.title}
      className={opts.rowClass?.(s, variant) ?? `${isArchived ? 'opacity-50 ' : ''}w-full flex items-center ${sessionRowClass} text-left hover:bg-[#1a2735] focus:bg-[#1f2f42] focus:outline-none`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_MIME, s.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onMouseEnter={() => opts.prefetch?.onEnter(s.id)}
      onMouseLeave={opts.prefetch?.onLeave}
      onClick={() => opts.onOpen(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(s.id, e.clientX, e.clientY);
      }}
    >
      {opts.leading?.(s, variant)}
      <span className={`flex-1 min-w-0 truncate ${opts.titleClass?.(s, variant) ?? ''}`}>
        {opts.title ? opts.title(s) : s.title}
      </span>
      {opts.badges?.(s, variant)}
      {opts.meta && (
        <span className={`shrink-0 ${sessionMetaClass}`}>{opts.meta(s, variant)}</span>
      )}
    </button>
  );
}

export function SessionRow<S extends SidebarSession>({
  node,
  collapsedChildren,
  onToggleChildren,
  registerRow,
  opts,
  onMenu,
}: {
  node: SessionTreeNode<S>;
  collapsedChildren: Set<string>;
  onToggleChildren: (id: string) => void;
  registerRow: (el: HTMLButtonElement | null) => void;
  opts: RowRenderOpts<S>;
  onMenu: (sessionId: string, x: number, y: number) => void;
}) {
  const s = node.session;
  const hasChildren = opts.hasChildren
    ? opts.hasChildren(node)
    : node.children.length > 0;
  const childrenVisible = !collapsedChildren.has(s.id);
  return (
    <>
      <div className="flex items-center" style={{ paddingLeft: node.depth * 12 }}>
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={childrenVisible ? 'Collapse children' : 'Expand children'}
            className="w-4 h-4 shrink-0 flex items-center justify-center text-[#8b9bb0] hover:text-[#c9d4e3]"
            onClick={(e) => {
              e.stopPropagation();
              onToggleChildren(s.id);
            }}
          >
            {childrenVisible ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <SessionRowButton
          s={s}
          depth={node.depth}
          current={node.current}
          registerRow={registerRow}
          opts={opts}
          onMenu={onMenu}
          variant="tree"
        />
      </div>
      {childrenVisible &&
        node.children.map((child) => (
          <SessionRow
            key={child.session.id}
            node={child}
            collapsedChildren={collapsedChildren}
            onToggleChildren={onToggleChildren}
            registerRow={registerRow}
            opts={opts}
            onMenu={onMenu}
          />
        ))}
    </>
  );
}
