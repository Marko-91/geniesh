/**
 * Markdown parser for streaming and complete-text output.
 * Handles real-time formatting of LLM tokens.
 */

// ─── Inline formatting ────────────────────────────────────────────────────────

function formatInline(text) {
  // bold first (** before *) to avoid partial matches
  text = text.replace(/\*\*(.*?)\*\*/g, "\x1b[1m$1\x1b[0m");
  // italic (* and _) — only when not adjacent to another * or _
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "\x1b[3m$1\x1b[0m");
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "\x1b[3m$1\x1b[0m");
  // inline code
  text = text.replace(/`([^`\n]+)`/g, "\x1b[32m$1\x1b[0m");
  return text;
}

// ─── Line-level formatting ────────────────────────────────────────────────────

const HEADER_COLORS = [
  "\x1b[1m\x1b[37m", // h1 — white bold
  "\x1b[1m\x1b[36m", // h2 — cyan bold
  "\x1b[1m\x1b[35m", // h3 — magenta bold
  "\x1b[1m\x1b[34m", // h4 — blue bold
  "\x1b[1m\x1b[33m", // h5 — yellow bold
  "\x1b[1m\x1b[32m", // h6 — green bold
];

function formatLine(line) {
  // headings: # … through ######
  const header = line.match(/^(#{1,6}) (.*)/);
  if (header) {
    const level = Math.min(header[1].length, 6) - 1;
    return `${HEADER_COLORS[level]}${formatInline(header[2])}\x1b[0m`;
  }

  // horizontal rule: ---, ***, ___  (3+ chars, nothing else on the line)
  if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
    return `\x1b[90m${"─".repeat(60)}\x1b[0m`;
  }

  // unordered list: - / * / + at any indent level
  const bullet = line.match(/^(\s*)([-*+]) (.+)/);
  if (bullet) {
    return `${bullet[1]}\x1b[33m•\x1b[0m ${formatInline(bullet[3])}`;
  }

  // ordered list: 1. 2. … at any indent level
  const numbered = line.match(/^(\s*)(\d+)\. (.+)/);
  if (numbered) {
    return `${numbered[1]}\x1b[33m${numbered[2]}.\x1b[0m ${formatInline(numbered[3])}`;
  }

  //handle links
  if (/\[([^\]]+)\]\((.*?)\)/.test(line)) {
    return line.replace(
      /\[([^\]]+)\]\((.*?)\)/g,
      (_, text, url) =>
        `\x1b]8;;${url}\x1b\\\x1b[36m${text}\x1b[0m\x1b]8;;\x1b\\ \x1b[90m(${url})\x1b[0m`,
    );
  }

  return formatInline(line);
}

// ─── formatMarkdown: formats a complete string (non-streaming) ────────────────

export function formatMarkdown(text) {
  // fenced code blocks must be processed before inline code
  // so the single-backtick regex can't consume the triple-backtick delimiters
  text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    const langStr = lang ? ` [${lang}]` : "";
    const formatted = code
      .replace(/\x1b\[[0-9;]*m/g, "") // strip any stale ANSI
      .replace(/^(.*)$/gm, "  $1"); // indent every line
    return `\x1b[44m\x1b[37m${langStr}\x1b[0m\n${formatted}\x1b[0m`;
  });

  // apply line-level formatting to remaining text
  return text.split("\n").map(formatLine).join("\n");
}

// ─── StreamingMarkdownParser ──────────────────────────────────────────────────
// Line-buffered: accumulates tokens until a newline arrives, then formats and
// emits the complete line. Fenced code blocks are accumulated in full before
// being formatted and emitted.

export class StreamingMarkdownParser {
  constructor() {
    this._lineBuffer = "";
    this._inCodeBlock = false;
    this._codeBlockLang = "";
    this._codeBlockLines = [];
  }

  /**
   * Feed a token from the LLM stream. Emits formatted text via write() for
   * every complete line received.
   * @param {string}   token
   * @param {Function} write  (formattedText: string) => void
   */
  feed(token, write) {
    this._lineBuffer += token;
    let idx;
    while ((idx = this._lineBuffer.indexOf("\n")) !== -1) {
      const line = this._lineBuffer.slice(0, idx);
      this._lineBuffer = this._lineBuffer.slice(idx + 1);
      this._processLine(line, write);
    }
  }

  /**
   * Flush any buffered content. Call when the stream ends.
   * @param {Function} write
   */
  flush(write) {
    if (this._inCodeBlock) {
      // unclosed fence — emit what we accumulated
      this._emitCodeBlock(write, false);
    }
    if (this._lineBuffer) {
      write(formatLine(this._lineBuffer));
      this._lineBuffer = "";
    }
  }

  _processLine(line, write) {
    if (this._inCodeBlock) {
      if (line.trimEnd() === "```") {
        this._emitCodeBlock(write, true);
      } else {
        this._codeBlockLines.push(line);
      }
    } else {
      const fence = line.match(/^```(\w*)$/);
      if (fence) {
        this._inCodeBlock = true;
        this._codeBlockLang = fence[1] || "";
        this._codeBlockLines = [];
      } else {
        write(formatLine(line) + "\n");
      }
    }
  }

  _emitCodeBlock(write, trailingNewline) {
    const langStr = this._codeBlockLang ? ` [${this._codeBlockLang}]` : "";
    write(`\x1b[44m\x1b[37m${langStr}\x1b[0m\n`);
    for (const l of this._codeBlockLines) write(`  ${l}\n`);
    write("\x1b[0m");
    if (trailingNewline) write("\n");
    this._inCodeBlock = false;
    this._codeBlockLang = "";
    this._codeBlockLines = [];
  }
}

// ─── Module-level instance (used by processToken/flush exports for tests) ─────

const _parser = new StreamingMarkdownParser();

export function processToken(token, writeCallback) {
  _parser.feed(token, writeCallback);
}

export function flush(writeCallback) {
  _parser.flush(writeCallback);
}
