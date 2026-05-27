export function formatMarkdown(text) {
  return text;
}

export class StreamingMarkdownParser {
  feed(token, write) {
    write(token);
  }
  flush(write) {
    // nothing to flush
  }
}

const _parser = new StreamingMarkdownParser();

export function processToken(token, writeCallback) {
  _parser.feed(token, writeCallback);
}

export function flush(writeCallback) {
  _parser.flush(writeCallback);
}
