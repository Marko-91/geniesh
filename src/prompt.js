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

export function buildCommitPrompt(diff, stat, recentLog) {
  const MAX = 3000;
  let truncated = diff.length > MAX
    ? diff.slice(0, MAX) + '\n… (diff truncated)' : diff;
  return `Generate a conventional commit message.

Changes: ${stat || 'unknown'}
${truncated ? '\nFirst lines of diff:\n' + truncated : ''}

Rules:
- Output ONLY the commit message. No markdown, no backticks, no shell commands, no commentary.
- Format: <type>(<scope>): <subject> followed by body if needed.
- Subject: imperative mood, no period, max 72 chars.
- Types: feat, fix, refactor, test, docs, style, chore, perf, ci, build, revert.

Recent commits for style reference:
${recentLog || '(none)'}`;
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

export const CHANGELOG_PROMPT = `
Generate a changelog in markdown from the commits below.

Categorize changes under these headings:
- **Features** — new capabilities
- **Bug Fixes** — bug resolutions
- **Refactors** — code structure changes
- **Deprecations** — deprecated features
- **Documentation** — docs changes
- **Other** — misc changes

Start with a high-level summary paragraph of what changed.
Then list changes grouped by category using bullet points.
Reference commit hashes (short form) in parentheses after each entry.`;

export function buildChangelogPrompt(log, messages) {
  const MAX = 30000;
  const truncated = messages.length > MAX
    ? messages.slice(0, MAX) + '\n… (truncated)' : messages;
  return `You are generating a changelog for a release.

${CHANGELOG_PROMPT}

## Commits
${log || '(no commits)'}

## Commit details
${truncated || '(none)'}`;
}

export const REVIEW_PROMPT = `
Review the code or diff below. Provide:

1. **Summary** — What does this code do? 1–2 sentences.
2. **Observations** — Code quality, potential bugs, missed edge cases, security concerns.
3. **Suggestions** — Concrete, actionable improvements (with code examples where helpful).

Cite specific line numbers. Be concise but thorough.`;

export function buildReviewPrompt(content, label = '') {
  const MAX = 50000;
  const truncated = content.length > MAX
    ? content.slice(0, MAX) + '\n… (content truncated)' : content;
  const header = label ? `## ${label}\n\n` : '';
  return `You are a senior engineer doing a code review.

${REVIEW_PROMPT}

## Content to review
${header}\`\`\`
${truncated}
\`\`\``;
}

export const STASH_LIST_PROMPT = `
Below is a list of stashes. For each stash provide:
- **Index** — stash number
- **Branch** — the branch it was created on
- **Summary** — 1-sentence description of what changed
- **Files** — key files modified

Format as a markdown table. Be concise.`;

export function buildStashListPrompt(entries) {
  return `You are describing git stash entries.\n\n${STASH_LIST_PROMPT}\n\n## Stashes\n${entries}`;
}

export const STASH_SHOW_PROMPT = `
Explain the changes in this git stash entry below.

Provide:
1. **Summary** — What does this stash contain? 1–2 sentences.
2. **Changes** — Key changes grouped by file, with what and why.
3. **State** — Is this complete work-in-progress or a finished feature?`;

export function buildStashShowPrompt(diff) {
  const MAX = 30000;
  const truncated = diff.length > MAX ? diff.slice(0, MAX) + '\n… (truncated)' : diff;
  return `You are explaining a git stash.\n\n${STASH_SHOW_PROMPT}\n\n## Stash diff\n\`\`\`diff\n${truncated}\n\`\`\``;
}

export const SHELL_PROMPT = `
Generate a single shell command for the task below.

Output in a code block:
\`\`\`bash
<command>
\`\`\`

Then provide a brief explanation (max 2 sentences). If the command is destructive
(rm, dd, >, format, etc.) flag it with ⚠️ in the explanation.

Rules:
- One command only. Chain with && if needed. Prefer portable POSIX.
- If the task is ambiguous, make a reasonable assumption and note it.`;

export function buildShellPrompt(query) {
  return `You are a shell command expert.\n\n${SHELL_PROMPT}\n\nTask: ${query}`;
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

export const DOCS_PROMPT = `
Generate documentation for the code below.

Include:
- A high-level summary of what this code does and its purpose
- For each exported function, class, or method: purpose, parameters, return value, and any notable edge cases
- A short usage example for key functions
- Document internal/private helpers briefly (1–2 lines each)

Output as markdown. Be concise but thorough.`;

export function buildDocsPrompt(content, label = '') {
  const MAX = 50000;
  const truncated = content.length > MAX
    ? content.slice(0, MAX) + '\n… (content truncated)'
    : content;
  return `You are a senior technical writer generating documentation for source code.

${DOCS_PROMPT}

${label ? `## File\n${label}\n` : ''}
## Source code
\`\`\`
${truncated}
\`\`\``;
}

export const BLAME_PROMPT = `
Below is a file with git blame annotations. Each line shows:
<commit-hash> <author> (<date> <line-number>) <line-content>

Group consecutive lines by the same commit and explain each change group:

- What was changed (in terms of code semantics)
- Why it was likely changed (based on the code and commit context)
- Any patterns, concerns, or technical debt to note

If multiple commits touched the same area, explain the evolution.`;

export function buildBlamePrompt(blameOutput, filePath) {
  const MAX = 30000;
  const truncated = blameOutput.length > MAX
    ? blameOutput.slice(0, MAX) + '\n… (blame output truncated)'
    : blameOutput;
  return `You are a senior engineer analyzing git blame history for ${filePath}.

${BLAME_PROMPT}

## Blame output
\`\`\`
${truncated}
\`\`\``;
}
