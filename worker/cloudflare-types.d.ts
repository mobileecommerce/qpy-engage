interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface HTMLRewriterElement {
  tagName: string;
  getAttribute(name: string): string | null;
  onEndTag(handler: () => void): void;
}

interface HTMLRewriterTextChunk {
  text: string;
  lastInTextNode: boolean;
}

interface HTMLRewriterElementHandlers {
  element?(element: HTMLRewriterElement): void;
  text?(chunk: HTMLRewriterTextChunk): void;
}

declare class HTMLRewriter {
  on(selector: string, handlers: HTMLRewriterElementHandlers): HTMLRewriter;
  transform(response: Response): Response;
}

declare module "cloudflare:workers" {
  export const env: { DB: D1Database };
}
