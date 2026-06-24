import { readdirSync } from 'fs';
import { join } from 'path';

const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx',
  '.py', '.rs', '.go', '.rb', '.java', '.php',
  '.cs', '.swift', '.kt', '.scala',
  '.c', '.h', '.cpp', '.hpp',
  '.lua', '.r', '.m',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'vendor', 'dist', 'build', '.next', '.nuxt',
  '__pycache__', '.venv', 'env', '.tox', '.eggs',
  'target', '.cargo',
  '.vscode', '.idea',
  'coverage', '.nyc_output',
  'bower_components', '.gem',
]);

const EXT_LANG = {
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
};

function buildBaseRules(project) {
  const lines = [
    'You are a senior software engineer with full read/write access to the codebase.',
    '',
    '## Context',
    '',
    'The message may contain sections delimited by markers:',
    '- `--- context ---` — code context with symbol definitions, call chains, and snippets.',
    '- `--- files ---` — full file contents from the project.',
    '- `--- web ---` — content fetched from the internet.',
    '',
    '## Citation rules',
    '',
    '- Every claim about code MUST cite the exact file and line number from the context.',
    '- If a file or line is not in the context, say so — do not invent it.',
    '- Do NOT ask for more files or context. Work only with what is provided above.',
    '- You may use general knowledge for analysis, but prefix it with "In general:" or',
    '  "A common pattern is:" so it is clear it is not from the code.',
    '',
    '## Coding rules',
    '',
    '- Prefer simple, minimal changes. Do not refactor unrelated code.',
    '- Do not propose additional abstraction layers unless the existing code',
    '  demonstrably fails at its task.',
    '',
    '## Code context',
  ];

  if (project) {
    const dirs = project.sourceDirs.join(', ');
    const langList = project.primaryLang && project.primaryLang !== 'Unknown'
      ? `\nPrimary languages: ${project.primaryLang}`
      : '';

    lines.push(
      '',
      `Project layout: ${project.topLevelLayout}${langList}`,
      `Source directories: ${dirs}`,
      '',
    );
  }

  lines.push(
    'Use the `--- context ---`, `--- files ---`, and `--- web ---` sections as your source of truth.',
    'Do not attempt to search the filesystem — all relevant code is provided in these sections.',
  );

  return lines.join('\n');
}

export const BASE_RULES = '\n' + buildBaseRules() + '\n';

// Kept as SYSTEM_RULES for backward compatibility (used by buildPrompt)
export const SYSTEM_RULES = BASE_RULES;

export const EDIT_RULES = `
## Edit format

Output SEARCH/REPLACE blocks:

    path/to/file.ext
    SEARCH
    <exact existing code — copy character-for-character from the file above>
    REPLACE
    <new code>

The SEARCH text must be COPIED CHARACTER-FOR-CHARACTER. Every space, indent,
and newline must match exactly. Do NOT rewrite, reformat, or paraphrase.
The file you need to edit is already in \`--- files ---\`. Do not search for it.
`;

const MAX_CONTEXT_CHARS = 16000;

export const ANALYSIS_PROMPT = `
You are asked to provide a deep analysis of the code provided in the context sections.

Cover these aspects:
1. **Purpose** — What does this code do? What problem does it solve?
2. **Interface** — Inputs, outputs, dependencies, exports/imports
3. **Flow** — How does it work step by step? Key code paths and decision points
4. **Patterns** — Design patterns, conventions, or architectural principles used
5. **Relationships** — How the code relates to other parts of the codebase (callers, callees, collaborators)
6. **Observations** — Notable details, edge cases, potential issues, or improvements

Be specific. Reference exact function names, class names, line numbers, and file paths.
Do NOT invent code that is not in the context.`;

export const PLAN_INSTRUCTION = `
[PLAN MODE — DO NOT WRITE CODE YET]
Produce a structured plan for the requested change. Cover:

1. **Goal** — Restate what needs to be built or changed
2. **Approach** — How you would implement it (specific files, functions, patterns)
3. **Design decisions** — Key tradeoffs and rationale
4. **Implementation steps** — Numbered steps in dependency order
5. **Files affected** — For each file: what kind of change (create, modify, delete)

Only use the context and files already provided.
Wait for user confirmation before writing any code.`;

export const DIFF_REVIEW_PROMPT = `
You are reviewing a pull request. Below is the complete diff of proposed changes.

Cover these areas in your review:
1. **Summary** — What does this PR do? 2–3 sentence high-level overview.
2. **File-by-file review** — For each changed file: what changed, why, code quality observations, potential bugs or edge cases.
3. **Gaps & Risks** — Missing error handling, tests, security issues, regressions, or incomplete changes.
4. **Suggestions** — Concrete, actionable improvements (with code examples where helpful).

Cite specific line numbers and file paths from the diff. Be thorough but practical.`;

export function buildDiffReviewPrompt(log, stat, diff) {
  const MAX = 50000;
  const truncated = diff.length > MAX
    ? diff.slice(0, MAX) + '\n… (diff truncated, review the visible portion)'
    : diff;
  return `You are a senior engineer doing a pull request review.

${DIFF_REVIEW_PROMPT}

## Commits
${log || '(no commit messages)'}

## Diff Statistics
${stat || '(no stats)'}

## Full Diff
\`\`\`diff
${truncated}
\`\`\``;
}

export const COMMIT_PROMPT = `
Generate a conventional commit message from the staged diff below.

Output ONLY the commit message — no commentary, no markdown, no backticks.

Format:
<type>(<scope>): <subject>

<body>

<footer>

Rules:
- Subject: imperative mood, no period, max 72 chars
- Body: explain what and why (not how), wrap at 72 chars
- Footer: "BREAKING CHANGE: ..." or "Closes #..." if applicable
- Types: feat, fix, refactor, test, docs, style, chore, perf, ci, build, revert`;

export function buildCommitPrompt(diff, recentLog) {
  const MAX = 30000;
  const truncated = diff.length > MAX
    ? diff.slice(0, MAX) + '\n… (diff truncated)' : diff;
  return `You are generating a git commit message.

${COMMIT_PROMPT}

## Recent commits (for style reference)
${recentLog || '(none)'}

## Staged diff
\`\`\`diff
${truncated}
\`\`\``;
}

export const PR_PROMPT = `
Generate a pull request description in markdown format from the diff below.

Start with a line:
Title: <short PR title>

Then the body covering:

## Summary
What does this PR do? 2–3 sentences.

## Changes
Key changes with brief explanations, grouped by area.

## Testing notes
How was this tested? What testing is still needed?

## Checklist
- [ ] Code follows project conventions
- [ ] Tests added/updated
- [ ] Documentation updated (if needed)

Be concise and factual. Reference issue numbers if mentioned in commits.`;

export function buildPrPrompt(log, stat, diff) {
  const MAX = 50000;
  const truncated = diff.length > MAX
    ? diff.slice(0, MAX) + '\n… (diff truncated)' : diff;
  return `You are writing a GitHub pull request description.

${PR_PROMPT}

## Commits
${log || '(no commit messages)'}

## Diff Statistics
${stat || '(no stats)'}

## Full Diff
\`\`\`diff
${truncated}
\`\`\``;
}

export function buildPrompt(query, chunks) {
  let context = '';
  for (const c of chunks) {
    const header = `\n// File: ${c.file} (lines ${c.startLine}–${c.endLine})\n`;
    const block = header + c.chunk + '\n';
    if (context.length + block.length > MAX_CONTEXT_CHARS) break;
    context += block;
  }
  const files = [...new Set(chunks.map(c => c.file))];
  return `You are a senior software engineer.

System rules:
${BASE_RULES}

Files:
${files.join(", ")}

Context:
${context}

Task:
${query}
`;
}

export function buildDirectPrompt(query, code, label = '') {
  const truncated = code.length > MAX_CONTEXT_CHARS
    ? code.slice(0, MAX_CONTEXT_CHARS) + '\n... (truncated)'
    : code;
  return `You are a senior software engineer.

Context:
${label ? `// ${label}\n` : ''}${truncated}

Task:
${query}

If there are bugs, list them. If the code is clean, say so.
List improvements and security issues only if you spot any.

Be concise and practical.`;
}

export function detectProjectStructure(dir) {
  const info = { sourceDirs: [], extensions: [], primaryLang: '', fileCount: 0, hasSrc: false, topLevelLayout: '' };
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const topLevel = [];
    const extCount = {};

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue;
      topLevel.push(name);

      if (entry.isDirectory() && !IGNORE_DIRS.has(name)) {
        scanDirForSource(dir, name, info, extCount, 0);
      } else if (entry.isFile()) {
        const ext = getExt(name);
        if (SOURCE_EXTS.has(ext)) {
          info.fileCount++;
          extCount[ext] = (extCount[ext] || 0) + 1;
        }
      }
    }

    if (info.fileCount > 0 && !info.sourceDirs.length) info.sourceDirs = ['.'];
    // If root-level source files exist, ensure '.' is included
    if (info.fileCount > 0 && !info.sourceDirs.includes('.')) info.sourceDirs.push('.');
    if (!info.sourceDirs.length) info.sourceDirs = ['.'];

    info.extensions = Object.keys(extCount).sort();
    info.primaryLang = getPrimaryLang(extCount);
    info.topLevelLayout = topLevel.join(', ');
    info.hasSrc = topLevel.includes('src');
  } catch {
    info.sourceDirs = ['.'];
    info.extensions = ['.js', '.ts', '.py'];
    info.primaryLang = 'JavaScript';
    info.hasSrc = false;
    info.topLevelLayout = '.';
  }
  return info;
}

function scanDirForSource(root, sub, info, extCount, depth) {
  if (depth > 2) return;
  const dirPath = join(root, sub);
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    let hasSource = false;
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) scanDirForSource(root, join(sub, entry.name), info, extCount, depth + 1);
      } else if (entry.isFile()) {
        const ext = getExt(entry.name);
        if (SOURCE_EXTS.has(ext)) {
          hasSource = true;
          info.fileCount++;
          extCount[ext] = (extCount[ext] || 0) + 1;
        }
      }
    }
    if (hasSource && !info.sourceDirs.includes(sub)) info.sourceDirs.push(sub);
  } catch {
    // skip unreadable dirs
  }
}

function getExt(name) {
  const i = name.lastIndexOf('.');
  if (i === -1) return '';
  if (name.endsWith('.d.ts')) return '.d.ts';
  return name.slice(i).toLowerCase();
}

function getPrimaryLang(extCount) {
  const PREFERENCE = ['.go', '.rs', '.ts', '.tsx', '.kt', '.swift', '.py', '.rb', '.java', '.php', '.js', '.jsx', '.mjs'];
  let maxExt = '';
  let maxCount = 0;
  for (const [ext, count] of Object.entries(extCount)) {
    if (count > maxCount || (count === maxCount && PREFERENCE.indexOf(ext) < PREFERENCE.indexOf(maxExt))) {
      maxCount = count;
      maxExt = ext;
    }
  }
  return EXT_LANG[maxExt] || 'Unknown';
}

export function buildSystemPrompt(dir) {
  const info = detectProjectStructure(dir);
  return buildBaseRules(info);
}
