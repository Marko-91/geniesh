import { execSync } from 'child_process';

const MB = 1024 * 1024;

/**
 * Run a git command and return stdout trimmed.
 * Throws with a clean error if the command fails.
 */
function git(args, opts = {}) {
  const cmd = `git ${args}`;
  const { maxBuffer = 5 * MB, encoding = 'utf-8' } = opts;
  return execSync(cmd, { encoding, maxBuffer }).trim();
}

/**
 * Gather diff context between two branches using merge-base semantics.
 *
 * @param {string} base  Base branch
 * @param {string} [head]  Feature branch (default: current HEAD)
 * @returns {{ head: string, mergeBase: string, log: string, stat: string, diff: string }}
 */
export function getBranchDiff(base, head) {
  head = head || git('rev-parse --abbrev-ref HEAD');
  const mergeBase = git(`merge-base "${base}" "${head}"`);
  const log = git(`log --oneline "${mergeBase}..${head}"`);
  const stat = git(`diff --stat "${mergeBase}..${head}"`);
  const diff = git(`diff "${mergeBase}..${head}"`, { maxBuffer: 50 * MB });
  return { head, mergeBase, log, stat, diff };
}

/**
 * Get staged diff (for commit message generation).
 *
 * @returns {{ diff: string, stat: string }}
 */
export function getStagedDiff() {
  const diff = git('diff --cached', { maxBuffer: 50 * MB });
  const stat = git('diff --cached --stat');
  return { diff, stat };
}

/**
 * Get recent commit log for style reference.
 *
 * @param {number} count
 * @returns {string}
 */
export function getRecentCommits(count = 5) {
  return git(`log --oneline -${count}`);
}
