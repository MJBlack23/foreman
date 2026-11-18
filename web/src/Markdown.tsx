import type { ReactNode } from "react";
import { Ext } from "./ui.tsx";

/**
 * Just enough markdown for a PR summary: paragraphs, "- " / "* " / "1. " lists,
 * `code`, **bold**, *italic* and [links](https://…). Builds React nodes, never HTML.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className="md">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const bullet = /^\s*[-*]\s+/;
        const numbered = /^\s*\d+[.)]\s+/;
        if (lines.every((l) => bullet.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(bullet, ""))}</li>)}</ul>;
        }
        if (lines.every((l) => numbered.test(l))) {
          return <ol key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(numbered, ""))}</li>)}</ol>;
        }
        return <p key={i}>{inline(lines.join(" "))}</p>;
      })}
    </div>
  );
}

const TOKEN = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|(?<![*\w])\*[^*\s][^*]*\*(?!\*))/g;

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(TOKEN)) {
    const t = m[0];
    if (m.index > last) out.push(s.slice(last, m.index));
    const k = out.length;
    if (t.startsWith("`")) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("[")) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(<Ext key={k} href={href!}>{label}</Ext>);
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
