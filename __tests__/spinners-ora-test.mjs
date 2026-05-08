import { spinners } from '../src/spinners-ora.js';

describe('spinners-ora', () => {
  describe('spinners', () => {
    it('should be an array', () => {
      expect(Array.isArray(spinners)).toBe(true);
    });

    it('should contain at least 10 spinners', () => {
      expect(spinners.length).toBeGreaterThan(10);
    });

    it('should include common spinners', () => {
      expect(spinners).toContain('dots');
      expect(spinners).toContain('line');
      expect(spinners).toContain('circle');
    });

    it('should have string elements', () => {
      spinners.forEach(spinner => {
        expect(typeof spinner).toBe('string');
      });
    });
  });
});