import { jest } from '@jest/globals';

const mockRunQuery = jest.fn();

jest.mock('../src/runner.js', () => ({
  runQuery: mockRunQuery,
}));

describe('LLM re-ranker', () => {
  let llmRank;

  beforeAll(async () => {
    const mod = await import('../src/llm-ranker.js');
    llmRank = mod.llmRank;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const candidates = [
    { file: '/router.php', grepScore: 1000, bm25Score: 0.72, roles: ['definition'], matchLine: 'class Router {', topTerms: [{ term: 'router', count: 5 }] },
    { file: '/kernel.php', grepScore: 520, bm25Score: 0.31, roles: ['import'], matchLine: 'use App\\Routing\\Router;', topTerms: [{ term: 'router', count: 2 }] },
    { file: '/test.php', grepScore: 0, bm25Score: 0.61, roles: [], matchLine: 'Router', topTerms: [{ term: 'router', count: 8 }] },
  ];

  it('returns ranked results when LLM responds', async () => {
    mockRunQuery.mockResolvedValue({
      content: JSON.stringify([
        { file: '/router.php', score: 10, reason: 'defines Router class' },
        { file: '/kernel.php', score: 7, reason: 'imports and calls Router' },
        { file: '/test.php', score: 5, reason: 'tests Router' },
      ]),
    });

    const result = await llmRank('How does Router::dispatch work?', candidates);
    expect(result.length).toBe(3);
    expect(result[0].file).toBe('/router.php');
    expect(result[0].score).toBe(10);
    expect(result[2].score).toBe(5);
  });

  it('returns empty for empty candidates', async () => {
    const result = await llmRank('question', []);
    expect(result).toEqual([]);
  });

  it('falls back to grep+BM25 combined score when LLM fails', async () => {
    mockRunQuery.mockRejectedValue(new Error('LLM unavailable'));

    const result = await llmRank('How does Router::dispatch work?', candidates);
    expect(result.length).toBe(3);
    expect(result[0].file).toBe('/router.php');
    expect(result[0].reason).toContain('fallback');
    expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
  });

  it('falls back when LLM returns invalid JSON', async () => {
    mockRunQuery.mockResolvedValue({ content: 'sorry, I cannot answer that' });

    const result = await llmRank('How does Router::dispatch work?', candidates);
    expect(result.length).toBe(3);
    expect(result[0].file).toBe('/router.php');
    expect(result[0].reason).toContain('fallback');
  });

  it('handles partially parsed JSON', async () => {
    mockRunQuery.mockResolvedValue({
      content: 'Here are my rankings:\n```json\n[' +
        '{"file": "/router.php", "score": 10, "reason": "defines it"},\n' +
        '{"file": "/kernel.php", "score": 7, "reason": "uses it"}\n' +
        ']\n```\n',
    });

    const result = await llmRank('How does Router::dispatch work?', candidates);
    expect(result.length).toBe(2);
    expect(result[0].file).toBe('/router.php');
  });

  it('clamps scores to 0-10 range', async () => {
    mockRunQuery.mockResolvedValue({
      content: JSON.stringify([
        { file: '/router.php', score: 99, reason: 'very relevant' },
        { file: '/test.php', score: -5, reason: 'negative' },
      ]),
    });

    const result = await llmRank('question', candidates);
    expect(result[0].score).toBe(10);
    expect(result[1].score).toBe(0);
  });

  it('sorts results by score descending', async () => {
    mockRunQuery.mockResolvedValue({
      content: JSON.stringify([
        { file: '/test.php', score: 3, reason: 'low' },
        { file: '/router.php', score: 10, reason: 'high' },
        { file: '/kernel.php', score: 5, reason: 'medium' },
      ]),
    });

    const result = await llmRank('question', candidates);
    expect(result[0].score).toBe(10);
    expect(result[1].score).toBe(5);
    expect(result[2].score).toBe(3);
  });
});
