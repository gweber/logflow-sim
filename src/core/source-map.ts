export interface SourceLoc {
  file: string;
  line: number;
  col: number;
  offset: number;
  length: number;
  endLine?: number;
  endCol?: number;
}

export function makeLoc(
  file: string,
  line: number,
  col: number,
  offset: number,
  length: number,
  endLine?: number,
  endCol?: number
): SourceLoc {
  return { file, line, col, offset, length, endLine, endCol };
}

export function sliceSource(content: string, loc: SourceLoc): string {
  return content.slice(loc.offset, loc.offset + loc.length);
}

export function offsetToLineCol(content: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;
  const n = Math.min(offset, content.length);
  for (let i = 0; i < n; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

export function spanLoc(a: SourceLoc, b: SourceLoc): SourceLoc {
  const start = a.offset <= b.offset ? a : b;
  const end = a.offset + a.length >= b.offset + b.length ? a : b;
  return {
    file: start.file,
    line: start.line,
    col: start.col,
    offset: start.offset,
    length: end.offset + end.length - start.offset,
    endLine: end.endLine ?? end.line,
    endCol: end.endCol ?? end.col + end.length
  };
}
