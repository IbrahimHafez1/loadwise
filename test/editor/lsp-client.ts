// A minimal Language Server Protocol client for the tests: it starts `loadwise lsp --stdio`, frames
// JSON-RPC messages, answers the server's requests and records its notifications.
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isRecord } from '../../lib/shared/is-record.js';

/** A request the server sends to the editor; the handler returns the result. */
type ServerRequestHandler = (params: unknown) => unknown;

export interface Notification {
  method: string;
  params: unknown;
}

export interface LspClient {
  child: ChildProcessWithoutNullStreams;
  notifications: Notification[];
  /** The latest diagnostics per URI. */
  diagnostics: Map<string, unknown[]>;
  /** The server's requests, in order, with their method and parameters. */
  serverRequests: Notification[];
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onRequest(method: string, handler: ServerRequestHandler): void;
  logs(): string[];
  stderr(): string;
  exited: Promise<number | null>;
}

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const headerEnd = '\r\n\r\n';

function frame(message: object): string {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  return 'Content-Length: ' + Buffer.byteLength(body) + headerEnd + body;
}

function startLspClient(cwd: string): LspClient {
  const child = spawn(process.execPath, [cli, 'lsp', '--stdio'], { cwd, windowsHide: true });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const handlers = new Map<string, ServerRequestHandler>();
  const notifications: Notification[] = [];
  const serverRequests: Notification[] = [];
  const diagnostics = new Map<string, unknown[]>();
  let buffer = Buffer.alloc(0);
  let errors = '';
  let nextId = 1;
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

  function send(message: object): void {
    child.stdin.write(frame(message));
  }
  function answer(id: unknown, method: string, params: unknown): void {
    serverRequests.push({ method, params });
    const handler = handlers.get(method);
    // A handler may answer later, as a slow editor would.
    void Promise.resolve(handler ? handler(params) : null).then((result) => send({ id, result }));
  }
  function receive(message: unknown): void {
    if (!isRecord(message)) return;
    const { id, method, params } = message;
    if (typeof method === 'string' && id !== undefined) return answer(id, method, params);
    if (typeof method === 'string') {
      notifications.push({ method, params });
      if (method === 'textDocument/publishDiagnostics' && isRecord(params) && typeof params.uri === 'string') {
        diagnostics.set(params.uri, Array.isArray(params.diagnostics) ? params.diagnostics : []);
      }
      return;
    }
    if (typeof id !== 'number') return;
    const waiting = pending.get(id);
    pending.delete(id);
    if (isRecord(message.error)) waiting?.reject(new Error(String(message.error.message)));
    else waiting?.resolve(message.result);
  }
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(headerEnd);
      if (end === -1) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
      const start = end + headerEnd.length;
      if (buffer.length < start + length) return;
      receive(JSON.parse(buffer.subarray(start, start + length).toString('utf8')));
      buffer = buffer.subarray(start + length);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    errors += text;
  });
  return {
    child,
    notifications,
    diagnostics,
    serverRequests,
    exited,
    request(method, params) {
      const id = nextId++;
      send({ id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method, params) {
      send({ method, params });
    },
    onRequest(method, handler) {
      handlers.set(method, handler);
    },
    logs: () =>
      notifications.flatMap(({ method, params }) =>
        method === 'window/logMessage' && isRecord(params) && typeof params.message === 'string'
          ? [params.message]
          : [],
      ),
    stderr: () => errors,
  };
}

async function until<Value>(probe: () => Value | undefined | false, what: string, timeoutMs = 20_000): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export { startLspClient, until };
