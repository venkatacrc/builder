// Minimal typing for the parts of `diff` (jsdiff v5) that Builder uses.
declare module 'diff' {
  export interface Change {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
  }
  export function diffLines(oldStr: string, newStr: string, options?: Record<string, unknown>): Change[];
}
