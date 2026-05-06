const MAX_CONTEXT_CHARS = 8000;


const SYSTEM_RULES = `
Rules:
- You MUST ONLY use the provided context
- If the answer is not in the context, say: "Not enough information in the provided code"
- Do NOT invent code paths, files, or behavior
- Do NOT assume missing implementation details
- Do NOT reference external sources or the internet
- Be concise and precise
- If unsure, prefer saying "Not enough information" instead of guessing
`;
``


/**
 * Builds a RAG prompt from retrieved code chunks.
 *
 * @param {string}   query
 * @param {object[]} chunks  Array of { file, chunk, startLine, endLine }
 * @returns {string}
 */
export function buildPrompt(query, chunks) {

  let context = '';
  //let files = [];
  for (const c of chunks) {
    const header = `\n// File: ${c.file} (lines ${c.startLine}–${c.endLine})\n`;
    const block = header + c.chunk + '\n';
    if (context.length + block.length > MAX_CONTEXT_CHARS) break;
    context += block;
    //files.push(c.file);
  }
  //console.log('File list:', fileList); // Log the file list for debugging
  //let fileList = files.join(', ');
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

Focus:
- Only analyze the provided code
- Be specific and reference files and lines when possible

Return structured output:

Bugs:
- ...

Security Issues:
- ...

Improvements:
- ...

Explanation:
- ...

Rules:
- Be concise
- Avoid generic advice
- Point to specific code when possible

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

Return:
- bugs
- improvements
- security issues
- explanation (if relevant)

Be concise and practical.`;
}
