import { cli } from './src/cli';

describe('CLI', () => {
  it('should handle index command correctly', async () => {
    const processMock = jest.spyOn(process, 'stdout');
    await cli(['index', '--dir', 'src/']);
    expect(processMock.mock.calls[0][0]).toBe('Indexing directory...\n');
  });

  it('should handle file query command correctly', async () => {
    const processMock = jest.spyOn(process, 'stdout');
    await cli(['find bugs', '--file', 'src/auth.ts']);
    expect(processMock.mock.calls[0][0]).toBe('Analyzing code snippet...\n');
  });

  it('should handle function query command correctly', async () => {
    const processMock = jest.spyOn(process, 'stdout');
    await cli(['explain this function', '--fn', 'login', '--file', 'src/auth.ts']);
    expect(processMock.mock.calls[0][0]).toBe('Analyzing login function...\n');
  });

  it('should handle dir query command correctly', async () => {
    const processMock = jest.spyOn(process, 'stdout');
    await cli(['how does authentication work?', '--dir', 'src/']);
    expect(processMock.mock.calls[0][0]).toBe('Retrieving relevant code chunks...\n');
  });

  it('should handle chat command correctly', async () => {
    const processMock = jest.spyOn(process, 'stdout');
    await cli(['chat']);
    expect(processMock.mock.calls[0][0]).toBe('Starting interactive chat session...\n');
  });
});