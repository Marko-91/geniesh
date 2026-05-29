const MAX_CONTEXT_CHARS = 16000;

export const SYSTEM_RULES = `
You are a senior software engineer with full read/write access to the codebase.

Rules:
- Every claim about code MUST cite the exact file and line number
  from the provided context above. If the file or line is not in the
  context, do not cite it.
- If you cannot cite it, it is not in the code — state that clearly.
- You may use general knowledge for analysis and suggestions, but preface
  general advice with "In general:" or "A common pattern is:" so the user
  knows it is not from the code.
- Never invent file names, function names, or line numbers.
- Prefer simple, minimal changes. Do not propose additional abstraction
  layers unless the existing code demonstrably fails at its task.
- Sections labeled "file-ref:" contain the ENTIRE file content (not just a
  window). Use the full content from these sections when proposing edits.
- If the user message contains a [Web page content] section, the content was
  fetched from a URL they asked about. Use it to answer their question — it
  is as authoritative as the codebase context.

Edit formats (output these and they will be detected and offered for approval):
1) Search/replace (preferred):
   src/utils.js
   SEARCH
   function greet(name) {
     return 'Hello, ' + name;
   }
   REPLACE
   function greet(name) {
     return 'Hi, ' + name;
   }
   The SEARCH text must match the EXISTING file content exactly.
2) Full-file (for rewrites):
   \`\`\`js:src/utils.js
   module.exports = { ... }
   \`\`\`
3) You can also use \`\`\`search / \`\`\`replace fenced pairs:
   \`\`\`search
   # BFS: method — src/Container.php
   old code
   \`\`\`
   \`\`\`replace
   new code
   \`\`\`

Shell commands: output a fenced code block with the bash language tag:
   \`\`\`bash
   npm install express
   \`\`\`
They will be detected and offered to the user. After running, you will see
the output and can continue with the next step.

Signal: If you need the full contents of a file not in the provided context,
output this exact signal on its own line:
   SIGNAL_REQUERY path/to/file.php
This will load the file and retry. Do NOT refuse — just output the signal.
Example: SIGNAL_REQUERY src/Container.php
`;


/**
 * Builds a RAG prompt from retrieved code chunks.
 *
 * @param {string}   query
 * @param {object[]} chunks  Array of { file, chunk, startLine, endLine }
 * @returns {string}
 */
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
${SYSTEM_RULES}

Files:
${files.join(", ")}

Context:
${context}

Task:
${query}

`;
}

/**
 * Builds a direct prompt from raw code (file or function mode).
 *
 * @param {string} query
 * @param {string} code
 * @param {string} [label]  Human-readable label for the code block
 * @returns {string}
 */
export function buildDirectPrompt(query, code, label = '') {
  const truncated =
    code.length > MAX_CONTEXT_CHARS
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
