import { z } from 'zod';
import type {
  Adapter,
  AdapterInput,
  HostFacts,
  ResourceReceipt,
} from '@ixo/agent-tools';
import type { SourceConfig } from './ports.js';
import {
  available,
  boundedText,
  digest,
  evidence,
  guarded,
  instant,
  revision,
  SourceFailure,
  type SourceHttp,
} from './http.js';

const vfsRevision = z.string().regex(/^[0-9a-f]{64}$/);
const scope = z.strictObject({
  userDid: z.string(),
  namespace: z.string(),
  path: z.string(),
});
const file = z.strictObject({
  id: z.string().min(1),
  version: z.number().int().positive(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  cid: z.string().nullable(),
  name: z.string().min(1).max(4000),
  path: z.string(),
  indexedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  revision: vfsRevision,
});
const snapshot = z.strictObject({
  scope,
  observedAt: instant,
  revisionKind: z.literal('metadata-observation'),
  coverage: z.enum(['complete', 'partial']),
  searchCoverage: z.enum(['partial', 'unverified']),
  snapshotRevision: vfsRevision,
  files: z.array(file).max(100),
});
const check = z.object({
  scope,
  observedAt: instant,
  current: z.boolean(),
  files: z
    .array(z.strictObject({ id: z.string(), current: z.boolean() }))
    .max(100),
});
const attachments = z.strictObject({
  receipts: z
    .array(
      z.strictObject({
        reference: z.string().min(1),
        revision,
        name: z.string().min(1).max(4000),
        receivedAt: instant,
        userDid: z.string(),
        sessionId: z.string(),
        messageId: z.string().min(1),
      }),
    )
    .max(100),
  complete: z.boolean(),
  reference: z.string().min(1),
  revision,
  observedAt: instant,
});
function inDate(
  instant: string,
  when: AdapterInput<'ixo_files_find'>['when'],
): boolean {
  if (!when) return true;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: when.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  return (
    `${part('year')}-${part('month')}-${part('day')}` === when.calendarDate
  );
}
function assertScope(value: z.output<typeof scope>, context: HostFacts): void {
  if (
    value.userDid !== context.userDid ||
    value.namespace !== `user:${context.userDid.split(':')[2]}` ||
    value.path !== '/'
  )
    throw new SourceFailure('unauthorized');
}
export function fileAdapters(http: SourceHttp, config: SourceConfig) {
  const ixo_files_find: Adapter<'ixo_files_find'> = ({ context, input }) =>
    guarded(async () => {
      const matches: {
        source: 'vfs' | 'attachment';
        reference: string;
        revision: string;
        name: string;
        uploadedAt: string;
        timeBasis: 'vfs_created' | 'session_received';
        indexedText: boolean;
      }[] = [];
      const coverage: (
        | {
            source: 'vfs' | 'attachment';
            state: 'complete' | 'partial';
            reference: string;
            revision: string;
          }
        | { source: 'vfs' | 'attachment'; state: 'unavailable' }
      )[] = [];
      const receipts: ReturnType<typeof evidence>[] = [];
      const query = input.query.toLocaleLowerCase('en-US');
      try {
        const data = snapshot.parse(
          await http.request(
            'vfs',
            context,
            '/api/fs/observations',
            undefined,
            'list',
          ),
        );
        assertScope(data.scope, context);
        let complete = data.coverage === 'complete';
        let reads = 0;
        for (const entry of data.files) {
          const uploadedAt = new Date(entry.createdAt * 1000).toISOString();
          if (!inDate(uploadedAt, input.when)) continue;
          const nameMatch = entry.name
            .toLocaleLowerCase('en-US')
            .includes(query);
          let textMatch = false;
          const indexed =
            entry.indexedBytes === entry.totalBytes && entry.indexedBytes > 0;
          if (!indexed || entry.totalBytes > 1_000_000 || reads >= 10)
            complete = false;
          else {
            reads++;
            try {
              const content = await boundedText(
                await http.raw(
                  'vfs',
                  context,
                  `/api/fs/files/${encodeURIComponent(entry.id)}/versions/${entry.version}/content`,
                ),
              );
              if ((await digest(content)) !== `sha256:${entry.contentHash}`)
                throw new SourceFailure('unavailable');
              textMatch = content.toLocaleLowerCase('en-US').includes(query);
            } catch {
              complete = false;
            }
          }
          if (nameMatch || textMatch) {
            const reference = `vfs:file:${encodeURIComponent(entry.id)}:${entry.version}`;
            matches.push({
              source: 'vfs',
              reference,
              revision: entry.revision,
              name: entry.name,
              uploadedAt,
              timeBasis: 'vfs_created',
              indexedText: indexed,
            });
            receipts.push(
              evidence('vfs', reference, entry.revision, data.observedAt),
            );
          }
        }
        coverage.push({
          source: 'vfs',
          state: complete ? 'complete' : 'partial',
          reference: 'vfs:snapshot',
          revision: data.snapshotRevision,
        });
        receipts.push(
          evidence(
            'vfs',
            'vfs:snapshot',
            data.snapshotRevision,
            data.observedAt,
          ),
        );
      } catch {
        coverage.push({ source: 'vfs', state: 'unavailable' });
      }
      try {
        const data = attachments.parse(
          await config.attachments.inventory(context),
        );
        for (const entry of data.receipts) {
          if (
            entry.userDid !== context.userDid ||
            entry.sessionId !== context.sessionId
          )
            throw new SourceFailure('unauthorized');
          if (
            entry.name.toLocaleLowerCase('en-US').includes(query) &&
            inDate(entry.receivedAt, input.when)
          ) {
            matches.push({
              source: 'attachment',
              reference: entry.reference,
              revision: entry.revision,
              name: entry.name,
              uploadedAt: entry.receivedAt,
              timeBasis: 'session_received',
              indexedText: false,
            });
            receipts.push(
              evidence(
                'attachment',
                entry.reference,
                entry.revision,
                data.observedAt,
              ),
            );
          }
        }
        coverage.push({
          source: 'attachment',
          state:
            data.complete && data.receipts.length === 0
              ? 'complete'
              : 'partial',
          reference: data.reference,
          revision: data.revision,
        });
        receipts.push(
          evidence(
            'attachment',
            data.reference,
            data.revision,
            data.observedAt,
          ),
        );
      } catch {
        coverage.push({ source: 'attachment', state: 'unavailable' });
      }
      if (!receipts.length || matches.length > 98 || receipts.length > 100)
        throw new SourceFailure('unavailable');
      return available(context, { matches, coverage }, receipts);
    });
  async function current(
    context: HostFacts,
    receipt: ResourceReceipt,
  ): Promise<boolean> {
    if (receipt.source === 'attachment')
      return config.attachments.current(
        context,
        receipt.reference,
        receipt.revision,
      );
    if (receipt.reference === 'vfs:snapshot') {
      const result = check.parse(
        await http.request(
          'vfs',
          context,
          '/api/fs/observations/check',
          { snapshotRevision: receipt.revision, files: [] },
          'list',
        ),
      );
      assertScope(result.scope, context);
      return result.current;
    }
    const match = /^vfs:file:([^:]+):([1-9][0-9]*)$/.exec(receipt.reference);
    if (!match?.[1] || !match[2]) return false;
    const currentSnapshot = snapshot.parse(
      await http.request(
        'vfs',
        context,
        '/api/fs/observations',
        undefined,
        'list',
      ),
    );
    assertScope(currentSnapshot.scope, context);
    const current = currentSnapshot.files.find(
      (entry) => entry.id === decodeURIComponent(match[1] ?? ''),
    );
    return (
      current?.revision === receipt.revision &&
      current.version === Number(match[2])
    );
  }
  return { adapters: { ixo_files_find }, current };
}
