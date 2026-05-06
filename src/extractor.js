/**
 * Extracts a named function/method from source code using brace-matching.
 * Handles: function declarations, arrow functions, class methods, async variants.
 *
 * @param {string} content  Full file contents
 * @param {string} fnName   Name of the function to extract
 * @returns {string|null}   Extracted function source, or null if not found
 */
export function extractFunction(content, fnName) {
  const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    // function fnName(...) {
    new RegExp(`((?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\([^)]*\\)\\s*\\{)`, 'm'),
    // const/let/var fnName = (async)? (...) => {
    new RegExp(
      `((?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[a-zA-Z_$][\\w$]*)\\s*=>\\s*\\{)`,
      'm',
    ),
    // class method: fnName(...) {
    new RegExp(`((?:async\\s+)?${escaped}\\s*\\([^)]*\\)\\s*\\{)`, 'm'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (!match) continue;

    const start = match.index;
    let depth = 0;
    let i = start;
    let foundOpen = false;

    while (i < content.length) {
      if (content[i] === '{') {
        depth++;
        foundOpen = true;
      } else if (content[i] === '}') {
        depth--;
        if (foundOpen && depth === 0) {
          return content.slice(start, i + 1);
        }
      }
      i++;
    }
  }

  return null;
}
