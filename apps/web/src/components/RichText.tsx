import { Fragment, type ReactNode } from 'react';

/** Inline `code` and **bold**, the only inline markup lab text uses. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

/** Paragraphs separated by blank lines, with "- " lines rendered as a bullet list. */
export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  text.split(/\n\s*\n/).forEach((block, b) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const bullets = lines.filter((l) => l.startsWith('- '));
    const prose = lines.filter((l) => !l.startsWith('- '));
    if (prose.length) blocks.push(<p key={`p${b}`}><Inline text={prose.join(' ')} /></p>);
    if (bullets.length)
      blocks.push(
        <ul key={`u${b}`}>
          {bullets.map((l, i) => (
            <li key={i}>
              <Inline text={l.slice(2)} />
            </li>
          ))}
        </ul>,
      );
  });
  return <>{blocks}</>;
}
