// Compact, coordinate-free text of a paper for the AI tool (source.json is ~10x larger).

const oneLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** `[<sentenceId>] <sentence>` lines in block order, with `## p.<n>` page markers. References are left out. */
export function paperText(source) {
  const sentences = source?.sentences ?? {};
  const lines = [];
  let page = null;
  for (const block of source?.blocks ?? []) {
    if (block.type === 'references') continue;
    if (Number.isInteger(block.page) && block.page !== page) {
      page = block.page;
      lines.push(`## p.${page}`);
    }
    const prefix = block.type === 'heading' ? '### '
      : block.type === 'caption' ? '(caption) '
      : block.inFigure ? '(figure text) '
      : '';
    for (const id of block.sentenceIds ?? []) {
      const s = sentences[id];
      if (!s) continue;
      lines.push(`${prefix}[${id}] ${oneLine(s.text)}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** One line per figure/table: `<label> | p.<page> | caption: <captionSentenceId>`. */
export function figuresText(source) {
  const lines = (source?.figures ?? []).map((f) => [f.label, Number.isInteger(f.page) ? `p.${f.page}` : null, f.captionSentenceId ? `caption: ${f.captionSentenceId}` : null].filter(Boolean).join(' | '));
  return lines.length ? `${lines.join('\n')}\n` : '';
}
