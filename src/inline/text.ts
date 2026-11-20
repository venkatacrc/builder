// Pure prompt-building / output-cleaning helpers (no `vscode` import, unit-tested).

/** Pull the replacement text out of a model answer (first fenced block, else the raw text). */
export function extractCode(answer: string): string {
  const fence = /```[\w+#.-]*[^\n]*\n([\s\S]*?)```/.exec(answer);
  if (fence) return fence[1].replace(/\n$/, '');
  // Unterminated fence (truncated output)
  const open = /```[\w+#.-]*[^\n]*\n([\s\S]*)$/.exec(answer);
  if (open) return open[1].replace(/\n$/, '');
  return answer.replace(/^\n+|\n+$/g, '');
}

export function buildInlinePrompt(p: {
  rel: string;
  lang: string;
  instruction: string;
  before: string;
  selected: string;
  after: string;
}): string {
  return [
    'Edit the code inside <selection> according to the instruction.',
    `File: ${p.rel} (${p.lang})`,
    `Instruction: ${p.instruction}`,
    '',
    '<before>',
    p.before,
    '</before>',
    '<selection>',
    p.selected,
    '</selection>',
    '<after>',
    p.after,
    '</after>',
    '',
    'Respond with ONLY the new replacement for the contents of <selection>, inside a single fenced code block.',
    'No explanations. Preserve indentation and the surrounding code style.',
    'If <selection> is empty, respond with the code to insert at that position.',
  ].join('\n');
}

export function buildCompletionPrompt(p: { rel: string; lang: string; prefix: string; suffix: string }): string {
  return [
    `Complete the code at the <CURSOR> marker in the file "${p.rel}" (${p.lang}).`,
    'Return ONLY the text to insert at <CURSOR>: no markdown fences, no explanations, and do not repeat code that already exists before or after the cursor.',
    'Keep it short: finish the current statement or block. If nothing useful can be added, return nothing.',
    '',
    '```',
    `${p.prefix}<CURSOR>${p.suffix}`,
    '```',
  ].join('\n');
}

/** Normalize a raw model answer into insertable text ('' = no suggestion). */
export function cleanCompletion(answer: string, prefix: string, suffix: string): string {
  let text = answer.trim() ? answer : '';
  if (!text) return '';
  if (/```/.test(text)) text = extractCode(text);
  text = text.replace(/<\/?CURSOR>/g, '');
  // Drop a leading repeat of what is already on the cursor's line.
  const lineStart = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lineStart.trim() && text.startsWith(lineStart)) text = text.slice(lineStart.length);
  // Drop a trailing repeat of the code that already follows the cursor.
  const nextLine = suffix.split('\n')[0];
  let cutEcho = false;
  if (nextLine.trim() && text.includes('\n') && text.trimEnd().endsWith(nextLine.trim())) {
    text = text.slice(0, text.lastIndexOf(nextLine.trim()));
    cutEcho = true; // keep the newline that separated it from the code we just removed
  }
  if (text.length > 2000) text = text.slice(0, 2000);
  return cutEcho ? text : text.replace(/\s+$/g, (m) => (m.includes('\n') ? '' : m));
}

/** Smallest single replacement that turns `a` into `b` (keeps cursors/scroll stable). */
export function trimCommon(a: string, b: string): { start: number; endOld: number; endNew: number } {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endOld = a.length;
  let endNew = b.length;
  while (endOld > start && endNew > start && a.charCodeAt(endOld - 1) === b.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  return { start, endOld, endNew };
}
