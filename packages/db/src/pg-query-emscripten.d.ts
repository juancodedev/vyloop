/**
 * Minimal ambient types for `pg-query-emscripten`, which ships a WebAssembly
 * build of libpg_query without TypeScript declarations.
 *
 * Only the surface the tests use is described. The parse result is the real
 * libpg_query `ParseResult`: on success `error` is null and `parse_tree` is
 * populated; on failure `error` carries the PostgreSQL parser message and the
 * tree is an empty object.
 *
 * The package parses SQL. It does not execute it, which is the entire reason
 * it is used here instead of a live connection.
 */
declare module 'pg-query-emscripten' {
  export interface ParseError {
    message: string;
    cursorpos: number;
  }

  export interface ParseResult {
    error: ParseError | null;
    parse_tree: unknown;
    stderr_buffer?: string;
  }

  export default class PgQueryModule {
    constructor(): Promise<PgQueryModule>;
    /** Parse one SQL statement. Throws only on internal failure, not on a syntax error. */
    parse(sql: string): ParseResult;
    /** Parse a semicolon-separated script. */
    parsePlPgSQL(sql: string): ParseResult;
    version(): string;
  }
}
