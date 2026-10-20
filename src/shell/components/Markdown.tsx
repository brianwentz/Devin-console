import { memo, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// react-markdown emits plain elements (no inline styles) so the shell CSP holds.
// Links are intercepted here and routed through the LinkRouter in main.
function onLinkClick(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  event.stopPropagation();
  const href = event.currentTarget.getAttribute('href');
  if (href) window.agentworkspace.localOpenLink(href);
}

const components = {
  a: ({ href, children }: { href?: string | undefined; children?: React.ReactNode | undefined }) => (
    <a href={href ?? '#'} onClick={onLinkClick} rel="noreferrer">
      {children}
    </a>
  ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
