/**
 * Control-character policy for text at the kernel's boundary — both directions.
 *
 * INBOUND (`hasControlChars`): prompt text, approval reasons, session file
 * paths. One definition, because the per-surface copies disagreed — the browser
 * allowed newlines in a typed denial reason, the Rust bridge did not, the REPL
 * checked nothing, and a path was checked with a third variant.
 *
 * The rule: a C0 control character is never legitimate in kernel-bound text
 * except where the field is genuinely multi-line (a prompt body, a denial
 * reason the user typed over several lines). There `\n`/`\r`/`\t` are fine;
 * everything else (`\u0000`-`\u0008`, `\u000b`, `\u000c`, `\u000e`-`\u001f`) is
 * an attempt to smuggle terminal control or a NUL into a log line or a frame.
 *
 * OUTBOUND (`oneLineText`): text on its way to a TERMINAL. The same characters
 * are the same hazard seen from the other side — and they arrive from outside
 * the host (a plugin's module load error, a config validation message), so they
 * are escaped rather than trusted. Both answers live here because they answer
 * one question about one class of code points.
 */
export interface TextPolicy {
  /** Allow `\n` / `\r` / `\t` (prompt bodies and reasons are typed over lines). */
  multiline?: boolean;
}

/** True when `text` contains a control character this policy forbids. */
export function hasControlChars(text: string, policy: TextPolicy = {}): boolean {
  const multiline = policy.multiline === true;
  return [...text].some((ch) => {
    const code = ch.codePointAt(0) ?? 0x20;
    if (code >= 0x20) return false;
    return !(multiline && (ch === '\n' || ch === '\r' || ch === '\t'));
  });
}

/**
 * One line of terminal text: control code points rendered as visible escapes.
 *
 * Escaping rather than dropping: `\r` and `\u001b` are INJECTION, not layout —
 * printed raw they overwrite what is already on the line, or set the terminal's
 * colour / title / cursor state. Dropping them would lose the "why" instead, and
 * the reader would think the reason was always that short. So `\n` → `\\n`,
 * `\t` → `\\t`, ESC and the rest of C0 / DEL / C1 → `\\xNN`: all of it readable
 * text, not one byte of it effective.
 *
 * This is the SINGLE implementation, and it lives in core because the hazard is
 * not any one surface's: the core log exit (`plugin/context.ts` defaultLog)
 * reaches stderr in every surface, and `core` has no upstream it may import — a
 * copy per consumer is the defect family this repo keeps removing. Consumers
 * therefore re-export it (cli's `lines.ts`) instead of owning a second version,
 * and every call site that paints untrusted data into a terminal line goes
 * through here rather than hoping the upstream is "probably clean".
 * @param text - any text crossing into a terminal line.
 * @returns one line, control code points rendered as visible escapes.
 */
export function oneLineText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0x20;
    const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (!control) {
      out += char;
      continue;
    }
    if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else out += `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return out;
}