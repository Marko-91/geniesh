import { extractFunction } from '../src/extractor.js';

describe('extractor', () => {
  describe('extractFunction', () => {
    it('should extract function declaration', () => {
      const content = `
function myFunc(a, b) {
  return a + b;
}
`;
      const result = extractFunction(content, 'myFunc');
      expect(result).toBe('function myFunc(a, b) {\n  return a + b;\n}');
    });

    it('should extract async function', () => {
      const content = `
async function asyncFunc() {
  await Promise.resolve();
}
`;
      const result = extractFunction(content, 'asyncFunc');
      expect(result).toBe('async function asyncFunc() {\n  await Promise.resolve();\n}');
    });

    it('should extract exported function', () => {
      const content = `
export function exportedFunc() {
  console.log('exported');
}
`;
      const result = extractFunction(content, 'exportedFunc');
      expect(result).toBe('export function exportedFunc() {\n  console.log(\'exported\');\n}');
    });

    it('should extract arrow function', () => {
      const content = `
const arrowFunc = (x) => {
  return x * 2;
};
`;
      const result = extractFunction(content, 'arrowFunc');
      expect(result).toBe('const arrowFunc = (x) => {\n  return x * 2;\n}');
    });

    it('should extract async arrow function', () => {
      const content = `
const asyncArrow = async () => {
  await fetch();
};
`;
      const result = extractFunction(content, 'asyncArrow');
      expect(result).toBe('const asyncArrow = async () => {\n  await fetch();\n}');
    });

    it('should extract class method', () => {
      const content = `
class MyClass {
  myMethod() {
    return 'method';
  }
}
`;
      const result = extractFunction(content, 'myMethod');
      expect(result).toBe('myMethod() {\n    return \'method\';\n  }');
    });

    it('should extract async class method', () => {
      const content = `
class MyClass {
  async asyncMethod() {
    await Promise.resolve();
  }
}
`;
      const result = extractFunction(content, 'asyncMethod');
      expect(result).toBe('async asyncMethod() {\n    await Promise.resolve();\n  }');
    });

    it('should handle nested braces', () => {
      const content = `
function nestedFunc() {
  if (true) {
    for (let i = 0; i < 10; i++) {
      console.log(i);
    }
  }
}
`;
      const result = extractFunction(content, 'nestedFunc');
      expect(result).toBe(`function nestedFunc() {
  if (true) {
    for (let i = 0; i < 10; i++) {
      console.log(i);
    }
  }
}`);
    });

    it('should return null if function not found', () => {
      const content = `
function otherFunc() {
  return;
}
`;
      const result = extractFunction(content, 'missingFunc');
      expect(result).toBeNull();
    });

    it('should handle special regex characters in function name', () => {
      const content = `
function func$pecial() {
  return;
}
`;
      const result = extractFunction(content, 'func$pecial');
      expect(result).toBe('function func$pecial() {\n  return;\n}');
    });
  });
});