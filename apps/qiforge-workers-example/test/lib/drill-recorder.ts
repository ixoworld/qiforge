/**
 * A tiny HTTP recorder the drill tools (`src/drill-plugin.ts`) report to:
 * every execution posts `{ token, phase: 'start' | 'end', receipt }`. The
 * durable-run drills read it back to prove how many times a tool actually
 * ran across a reset (a write: once; a read: twice).
 */
import { createServer, type Server } from 'node:http';

export interface DrillRecord {
  token: string;
  phase: 'start' | 'end';
  receipt: string;
  at: number;
}

export interface DrillRecorder {
  url: string;
  records: (token: string) => DrillRecord[];
  starts: (token: string) => number;
  close: () => Promise<void>;
}

export async function startDrillRecorder(port = 34677): Promise<DrillRecorder> {
  const records: DrillRecord[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/record') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as Partial<DrillRecord>;
          if (
            typeof parsed.token === 'string' &&
            (parsed.phase === 'start' || parsed.phase === 'end')
          ) {
            records.push({
              token: parsed.token,
              phase: parsed.phase,
              receipt: String(parsed.receipt ?? ''),
              at: Date.now(),
            });
          }
        } catch {
          /* ignore */
        }
        res.writeHead(204).end();
      });
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/records')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(records));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) =>
    server.listen(port, '127.0.0.1', resolve),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    records: (token) => records.filter((r) => r.token === token),
    starts: (token) =>
      records.filter((r) => r.token === token && r.phase === 'start').length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
