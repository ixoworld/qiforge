import { z } from 'zod';
import { OraclePlugin } from '../../plugin-api/oracle-plugin.js';
import type {
  PluginManifest,
  PluginTool,
  RuntimeContext,
} from '../../plugin-api/types.js';
import { createVfsSandboxTools } from './vfs-sandbox-tools.js';
import { createVfsTools } from './vfs-tools.js';

/**
 * VFS + UCAN Store worker URLs per IXO network. The plugin derives these from
 * the `NETWORK` env var — there is nothing to configure. Bundled and always-on;
 * opt out with `features: { vfs: false }`.
 */
const NETWORK_URLS: Record<
  'mainnet' | 'testnet' | 'devnet',
  { vfs: string; store: string }
> = {
  mainnet: {
    vfs: 'https://vfs.ixo.earth',
    store: 'https://store.ucan.ixo.earth',
  },
  testnet: {
    vfs: 'https://testnet.vfs.ixo.earth',
    store: 'https://testnet.store.ucan.ixo.earth',
  },
  devnet: {
    vfs: 'https://devnet.vfs.ixo.earth',
    store: 'https://devnet.store.ucan.ixo.earth',
  },
};

/** Optional tuning env this plugin owns (the worker URLs come from NETWORK). */
const configSchema = z.object({
  VFS_MAX_READ_LINES: z.coerce.number().int().positive().default(2000),
  VFS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
});

/**
 * Sibling env the VFS plugin reads but does not own. `NETWORK` (owned by the
 * base runtime schema) selects the worker URLs; `SANDBOX_MCP_URL` (owned by the
 * sandbox plugin), when set, adds the two sandbox↔files bridge tools so a file
 * can move between the two without its bytes passing through the LLM.
 */
const siblingEnvSchema = z.object({
  NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
  SANDBOX_MCP_URL: z.url().optional(),
});

/** Runtime VFS config the client + tools consume. URLs derived from NETWORK. */
export interface VfsConfig {
  VFS_BASE_URL: string;
  UCAN_STORE_URL: string;
  VFS_MAX_READ_LINES: number;
  VFS_REQUEST_TIMEOUT_MS: number;
}

const manifest: PluginManifest = {
  title: 'Files',
  summary:
    "The user's Virtual Filesystem (VFS) — their persistent, secure, governed filesystem: the canonical home for their real documents, notes, datasets, and artifacts, in folders, searchable and versioned linked to their domain. Reusable context that lives across sessions — not scratch files, not chat attachments, not the web. Securely stored and access-controlled (managed encryption); authorized IXO services can read content to power search, previews, and these tools, so it is NOT end-to-end encrypted — never describe it as zero-knowledge or unreadable by IXO.",
  category: 'data',
  visibility: 'always',
  whenToUse: [
    "The user refers to a document, note, file, folder, or something they 'saved', 'uploaded', or 'shared with you'.",
    'You need to create, update, or organise a file for the user (draft, report, notes, export) that should persist.',
    'You need to find or quote something from the user\'s files ("what did my notes say about X", "find the contract").',
    'You can reuse a file the user already has instead of asking them to paste or re-upload it.',
    'The user asks you to share a file or make it downloadable.',
    "Persist something the sandbox produced (a report, export, chart, or dataset under /workspace/…) into the user's files so it survives the session — use `sandbox_to_vfs`.",
    "Feed one of the user's files into the sandbox so `sandbox_run` code can process it — use `vfs_to_sandbox` (writes under /workspace/data/).",
    'Remember you act ONLY within the files and rights the user granted you. If a file action reports you have no access (or only read-only), relay the short grant steps the tool returns — with your agent DID — so the user can authorize you, then retry. Never claim a file is missing when the real issue is access.',
  ],
  whenNotToUse: [
    "General knowledge or web questions — the files are the user's private content, not a knowledge base of the world.",
    "Content the user pasted directly into chat (act on that inline; don't write it to a file unless asked).",
    "Temporary/scratch or intermediate files produced during a code or compute run — those belong to the sandbox, not the user's filesystem.",
    'Another plugin owns the data (flows, skills, memory) — use that plugin.',
  ],
  examples: [
    {
      user: 'What did my project notes say about the launch date?',
      thought: "Search the user's files, then read the relevant lines.",
      tool: 'vfs_search',
      args: { q: 'launch date', path: '/' },
    },
    {
      user: 'Save this summary as notes/meeting-2026-07.md',
      thought: 'Create the file at that path.',
      tool: 'vfs_write',
      args: { path: '/notes/meeting-2026-07.md' },
    },
    {
      user: 'In todo.md change "Draft" to "Final"',
      thought: 'Exact-string edit.',
      tool: 'vfs_edit',
      args: { path: '/todo.md', oldString: 'Draft', newString: 'Final' },
    },
    {
      user: 'Share my resume so I can send a link',
      thought: 'Publish it and return the link.',
      tool: 'vfs_share',
      args: { path: '/resume.pdf', public: true },
    },
  ],
};

/**
 * VFS plugin.
 *
 * Contributes ten file tools (`vfs_search`, `vfs_grep`, `vfs_glob`,
 * `vfs_list`, `vfs_read`, `vfs_write`, `vfs_edit`, `vfs_move`, `vfs_delete`,
 * `vfs_share`) that read, create, edit, search, organise, and share a user's
 * files on the IXO Virtual Filesystem. The oracle acts as the user, inside the
 * folder the user delegated to it; each tool resolves a fresh single-use UCAN
 * bearer per call.
 *
 * When the sandbox is also configured (`SANDBOX_MCP_URL`, a sibling env owned
 * by the sandbox plugin), two extra bridge tools are added — `sandbox_to_vfs`
 * and `vfs_to_sandbox` — that move a file between the user's sandbox and their
 * files entirely server-side, so the bytes never pass through the LLM.
 *
 * Tools are request-time (`getRequestTools`) because auth needs the live
 * `rtCtx.user.did` and the user's deposited delegation. With no signing key,
 * or invalid config, the plugin contributes nothing and the agent simply
 * doesn't see the filesystem that turn.
 */
export class VfsPlugin extends OraclePlugin {
  readonly name = 'vfs';

  readonly version = '1.0.0';

  readonly manifest = manifest;

  override readonly configSchema = configSchema;

  override getRequestTools(rtCtx: RuntimeContext): PluginTool[] {
    if (!rtCtx.ucan.hasSigningKey()) {
      rtCtx.logger.warn('[vfs] skipping — oracle has no UCAN signing key.');
      return [];
    }

    const tuning = configSchema.safeParse(rtCtx.config);
    const siblings = siblingEnvSchema.safeParse(rtCtx.config);
    const network = (siblings.success && siblings.data.NETWORK) || 'devnet';
    const urls = NETWORK_URLS[network];
    const cfg: VfsConfig = {
      VFS_BASE_URL: urls.vfs,
      UCAN_STORE_URL: urls.store,
      VFS_MAX_READ_LINES: tuning.success ? tuning.data.VFS_MAX_READ_LINES : 2000,
      VFS_REQUEST_TIMEOUT_MS: tuning.success
        ? tuning.data.VFS_REQUEST_TIMEOUT_MS
        : 20000,
    };

    const tools = createVfsTools({ cfg });

    // When the sandbox is configured, add the two sandbox↔files bridge tools.
    // The sandbox MCP client is built lazily inside each handler, so adding
    // them costs nothing until one is actually called.
    const sandboxMcpUrl = siblings.success
      ? siblings.data.SANDBOX_MCP_URL
      : undefined;
    if (sandboxMcpUrl) {
      tools.push(...createVfsSandboxTools({ vfsCfg: cfg, sandboxMcpUrl }));
    }

    return tools;
  }
}
