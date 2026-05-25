import { parserActionTool, parserBrowserTool } from '@ixo/common';
import { type IRunnableConfigWithRequiredFields } from '@ixo/matrix';
import { OpenIdTokenProvider } from '@ixo/oracles-chain-client';
import { SqliteSaver } from '@ixo/sqlite-saver';
import { Logger } from '@nestjs/common';
import {
  createAgent,
  toolRetryMiddleware,
  type ReactAgent,
  type StructuredTool,
} from 'langchain';
import { type BlobStoreService } from 'src/blob-store/blob-store.service';
import { getConfig, isRedisEnabled } from 'src/config';
import { type UcanService } from 'src/ucan/ucan.service';

import { createPageContextMiddleware } from '../middlewares/page-context-middleware';
import { createTokenLimiterMiddleware } from '../middlewares/token-limiter-middelware';
import { createToolValidationMiddleware } from '../middlewares/tool-validation-middleware';
import {
  AI_ASSISTANT_PROMPT,
  buildOracleSection,
  SLACK_FORMATTING_CONSTRAINTS_CONTENT,
} from '../nodes/chat-node/prompt';
import { type TMainAgentGraphState } from '../state';
import { contextSchema } from '../types';
import { createAguiAgent } from './agui-agent';
import { createDomainIndexerAgent } from './domain-indexer-agent';
import { createApplySandboxOutputToBlockTool } from './editor/apply-sandbox-output-to-block';
import { createEditorAgent } from './editor/editor-agent';
import {
  logEditorSessionToMemory,
  type PageMemoryAuth,
} from './editor/page-memory';
import {
  EDITOR_MODE_PROMPTS,
  STANDALONE_EDITOR_PROMPTS,
} from './editor/prompts';
import { createStandaloneEditorTool } from './editor/standalone-editor-tool';
import { createFirecrawlAgent } from './firecrawl-agent';
import { createMemoryAgent } from './memory-agent';
import { createPortalAgent } from './portal-agent';
import { createSubagentAsTool, type AgentSpec } from './subagent-as-tool';
import { createTaskManagerAgent } from './task-manager';

import { DynamicStructuredTool } from 'langchain';
import fs from 'node:fs';
import path from 'node:path';
import {
  type FileProcessingService,
  type SandboxUploadConfig,
} from 'src/messages/file-processing.service';
import {
  SecretsService,
  type SecretIndexEntry,
} from 'src/secrets/secrets.service';
import type { TaskExecutionContext } from 'src/tasks/processors/processor-utils';
import { type TasksService } from 'src/tasks/task.service';
import { UserMatrixSqliteSyncService } from 'src/user-matrix-sqlite-sync-service/user-matrix-sqlite-sync-service.service';
import z from 'zod';
import oracleConfigRaw from '../../../oracle.config.json';

// Normalize optional fields: convert empty strings to undefined so downstream
// truthiness checks (`if (oracleConfig.model)`) are unambiguous.
const oracleConfig = {
  ...oracleConfigRaw,
  model: oracleConfigRaw.model || undefined,
  prompt: {
    opening: oracleConfigRaw.prompt.opening || undefined,
    communicationStyle: oracleConfigRaw.prompt.communicationStyle || undefined,
    capabilities: oracleConfigRaw.prompt.capabilities || undefined,
  },
};
import { ChannelMemoryService } from '../../channel-memory/channel-memory.service';
import { getProviderChatModel } from '../llm-provider';
import { createMCPClient, createMCPClientAndGetTools } from '../mcp';
import { createChannelMemoryTools } from '../nodes/tools-node/channel-memory-tools';
import { createFileProcessingTool } from '../nodes/tools-node/file-processing-tool';
import { createListRoomFilesTool } from '../nodes/tools-node/list-room-files-tool';
import {
  createListSkillsTool,
  createSearchSkillsTool,
} from '../nodes/tools-node/skills-tools';
import { getComposioTools } from '../nodes/tools-node/tools';
import { createSetUserPreferencesTool } from '../nodes/tools-node/user-preferences-tool';
import {
  UserPreferencesService,
  type UserPreferences,
} from 'src/user-preferences/user-preferences.service';

const COMPOSIO_CONTEXT = `## 🔌 External App Tools (Composio)

You can interact with third-party SaaS apps on behalf of the user — Gmail, GitHub, Linear, Notion, Slack, Google Calendar, Sheets, Drive, Jira, HubSpot, and hundreds more.

### When to use Composio
- User asks to **send/read/search emails** → Composio (Gmail, Outlook)
- User asks to **create issues, PRs, stars** → Composio (GitHub, Linear, Jira)
- User asks to **manage calendar events** → Composio (Google Calendar)
- User asks to **interact with any external SaaS app** → Composio
- **Skill not found?** → Before giving up, try \`COMPOSIO_SEARCH_TOOLS\` — the capability might exist as an external app tool
- **Normal conversation / general questions** → Just chat, no tools needed

### How it works (internal — never explain this to the user)
1. Call \`COMPOSIO_SEARCH_TOOLS\` with what you need (e.g. "send email", "create github issue")
2. If the toolkit has no active connection → call \`COMPOSIO_MANAGE_CONNECTIONS\`. The authorization UI will appear automatically in the user's interface. Just tell the user: "I need you to connect your [app]. You should see an authorization prompt — once you're done, send me a message and I'll continue." Do NOT paste URLs or links in chat.
3. Once the user confirms → execute the tool and report results.

### Rules
- **Never expose internals**: tool counts, toolkit names, connection statuses, schema details — keep all of this in your reasoning. The user sees only results and auth links.
- **Never invent tool slugs or arguments.** If unclear, call \`COMPOSIO_GET_TOOL_SCHEMAS\`.
- **Warn before destructive actions** (delete, bulk send, overwrite, revoke) — get user confirmation first.
- **Handle pagination** until complete when the user asks for "all" results.
- **Never claim you did something you didn't actually execute.**`;

/**
 * Convert a memory engine SearchEnhancedResponse into clean markdown.
 * Extracts only the meaningful content (facts + entity names) and drops
 * internal metadata (strategy_used, query, UUIDs, total_results).
 *
 * Accepts unknown to avoid coupling to the SearchEnhancedResponse type
 * while safely extracting the fields that exist at runtime.
 */
function formatUserContext(data: unknown): string {
  if (!data || typeof data !== 'object') return '_No information available._';

  const obj = data as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return '_No information available._';

  const lines: string[] = [];

  // Extract facts — array of { fact: string, ... }
  const facts = Array.isArray(obj.facts) ? obj.facts : [];
  for (const f of facts) {
    const fact =
      typeof f === 'object' && f !== null && 'fact' in f
        ? String(f.fact)
        : null;
    if (fact) lines.push(`- ${fact}`);
  }

  // Extract entity names — array of { name: string, ... }
  const entities = Array.isArray(obj.entities) ? obj.entities : [];
  const names = entities
    .map((e) =>
      typeof e === 'object' && e !== null && 'name' in e
        ? String(e.name)
        : null,
    )
    .filter(Boolean);
  if (names.length > 0) lines.push(`- **Related:** ${names.join(', ')}`);

  return lines.length > 0 ? lines.join('\n') : '_No information available._';
}

/**
 * Render the user's stored preferences as a markdown bullet list for injection
 * into the system prompt. Returns an empty string when no prefs are set so the
 * mustache `{{#USER_PREFERENCES_CONTEXT}}` block is omitted entirely.
 */
function formatUserPreferences(prefs?: UserPreferences): string {
  if (!prefs) return '';

  const lines: string[] = [];
  if (prefs.agentName)
    lines.push(`- **Preferred agent name:** ${prefs.agentName}`);
  if (prefs.language) lines.push(`- **Preferred language:** ${prefs.language}`);
  if (prefs.tone) lines.push(`- **Tone:** ${prefs.tone}`);
  if (prefs.formality) lines.push(`- **Formality:** ${prefs.formality}`);
  if (prefs.customInstructions)
    lines.push(`- **Custom instructions:** ${prefs.customInstructions}`);

  return lines.join('\n');
}

interface InvokeMainAgentParams {
  state: Partial<TMainAgentGraphState>;
  config: IRunnableConfigWithRequiredFields;
  /** Optional UCAN service for MCP tool authorization */
  ucanService?: UcanService;
  /** Optional blob store — used by tools that produce or consume long
   * opaque strings (UCAN CARs, etc.) without round-tripping them through
   * the LLM. Required for `mint_invocation` to return a blobId, and for
   * `sandbox_write_blob` to look one up. */
  blobStore?: BlobStoreService;
  /** Optional file processing service for the process_file tool */
  fileProcessingService?: FileProcessingService;
  /** Optional model override — a provider model ID (e.g. from getModelForRole). When set, overrides the default 'main' model. */
  modelOverride?: string;
  /** Optional TasksService for the Task Manager sub-agent */
  tasksService?: TasksService;
}

const configService = getConfig();
const llm = getProviderChatModel('main', {});

/**
 * Mint a UCAN service invocation and return it as a header pair.
 *
 * Encapsulates the common pattern of:
 *   1. calling `ucanService.createServiceInvocation`,
 *   2. wrapping the resulting token in a single-key header object,
 *   3. degrading silently on null / thrown errors.
 *
 * Returns `{}` (empty header set) on null result or thrown error so the
 * caller can spread it unconditionally. When `bearer` is true, the token
 * is prefixed with `Bearer ` to form a valid `Authorization` header value.
 */
async function mintInvocationHeader(args: {
  ucanService: UcanService;
  serviceUrl: string;
  userDid: string;
  resource: 'ixo:sandbox' | 'ixo:skills';
  headerName: string;
  bearer?: boolean;
  successLogContext: string;
  failureLogContext: string;
}): Promise<Record<string, string>> {
  const {
    ucanService,
    serviceUrl,
    userDid,
    resource,
    headerName,
    bearer = false,
    successLogContext,
    failureLogContext,
  } = args;
  try {
    const invocation = await ucanService.createServiceInvocation(
      serviceUrl,
      userDid,
      resource,
    );
    if (invocation) {
      Logger.debug(successLogContext);
      return { [headerName]: bearer ? `Bearer ${invocation}` : invocation };
    }
    return {};
  } catch (err) {
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    Logger.warn(`${failureLogContext}: ${detail}`);
    return {};
  }
}

const oracleMatrixBaseUrl = configService
  .getOrThrow('MATRIX_BASE_URL')
  .replace(/\/$/, '');

const oracleOpenIdTokenProvider = new OpenIdTokenProvider({
  matrixAccessToken: configService.getOrThrow(
    'MATRIX_ORACLE_ADMIN_ACCESS_TOKEN',
  ),
  homeServerUrl: oracleMatrixBaseUrl,
  matrixUserId: configService.getOrThrow('MATRIX_ORACLE_ADMIN_USER_ID'),
});

export const createMainAgent = async ({
  state,
  config,
  ucanService,
  blobStore,
  fileProcessingService,
  modelOverride,
  tasksService,
}: InvokeMainAgentParams): // eslint-disable-next-line @typescript-eslint/no-explicit-any
Promise<ReactAgent<any>> => {
  const msgFromMatrixRoom = Boolean(
    state.messages?.at(-1)?.additional_kwargs.msgFromMatrixRoom,
  );

  const { configurable } = config;
  const { matrix } = configurable?.configs ?? {};
  Logger.log(
    `[createMainAgent] homeServerName: ${configurable.configs?.matrix.homeServerName}`,
  );
  // Derive user's Matrix ID from DID + homeserver for page invitations
  const userDid = configurable?.configs?.user?.did;
  const homeServer = configurable?.configs?.matrix?.homeServerName;
  const userMatrixId =
    userDid && homeServer
      ? `@${userDid.replace(/:/g, '-')}:${homeServer}`
      : undefined;
  const oracleOpenIdToken = configurable.configs?.user.matrixOpenIdToken
    ? await oracleOpenIdTokenProvider.getToken()
    : undefined;

  // Build memory auth for page/block operation tracking
  const pageMemoryAuth: PageMemoryAuth | undefined =
    oracleOpenIdToken &&
    configurable.configs?.user.matrixOpenIdToken &&
    matrix?.roomId
      ? {
          oracleToken: oracleOpenIdToken,
          userToken: configurable.configs.user.matrixOpenIdToken,
          oracleHomeServer: oracleMatrixBaseUrl.replace(/^https?:\/\//, ''),
          userHomeServer: configurable.configs.matrix.homeServerName ?? '',
          chatRoomId: matrix.roomId,
        }
      : undefined;

  Logger.log(
    `[createMainAgent] PageMemory auth ${pageMemoryAuth ? 'available' : 'unavailable (missing tokens or roomId)'}`,
  );

  // Load secret index + user preferences in parallel (cheap — one state query each).
  // Both are wrapped so a failure in either never blocks oracle startup.
  const roomId = configurable.configs?.matrix.roomId;
  const [secretIndex, userPreferences] = await Promise.all<
    [Promise<SecretIndexEntry[]>, Promise<UserPreferences | undefined>]
  >([
    roomId
      ? SecretsService.getInstance()
          .getSecretIndex(roomId)
          .catch((err: unknown) => {
            Logger.warn(
              `[createMainAgent] Failed to load secret index: ${err instanceof Error ? err.message : String(err)}`,
            );
            return [];
          })
      : Promise.resolve([]),
    roomId
      ? UserPreferencesService.getInstance()
          .get(roomId)
          .catch((err: unknown) => {
            Logger.warn(
              `[createMainAgent] Failed to load user preferences: ${err instanceof Error ? err.message : String(err)}`,
            );
            return undefined;
          })
      : Promise.resolve(undefined),
  ]);

  // Build base headers for sandbox MCP (auth only — secrets added lazily)
  // Try UCAN invocation first, fall back to Matrix OpenID tokens
  const matrixFallbackHeaders: Record<string, string> = {
    Authorization: `Bearer ${configurable.configs?.user.matrixOpenIdToken}`,
    'x-matrix-homeserver': configurable.configs?.matrix.homeServerName ?? '',
    'X-oracle-openid-token': oracleOpenIdToken ?? '',
    'x-oracle-homeserver': oracleMatrixBaseUrl.replace(/^https?:\/\//, ''),
  };

  let sandboxHeaders: Record<string, string> = matrixFallbackHeaders;

  if (ucanService?.hasSigningKey() && configurable.configs?.user?.did) {
    const sandboxAuthHeader = await mintInvocationHeader({
      ucanService,
      serviceUrl: configService.getOrThrow('SANDBOX_MCP_URL'),
      userDid: configurable.configs.user.did,
      resource: 'ixo:sandbox',
      headerName: 'Authorization',
      bearer: true,
      successLogContext: '[UCAN] Using UCAN invocation for sandbox auth',
      failureLogContext:
        '[UCAN] Failed to create sandbox invocation, falling back to Matrix auth',
    });
    if (sandboxAuthHeader.Authorization) {
      sandboxHeaders = {
        ...sandboxAuthHeader,
        'X-Auth-Type': 'ucan',
      };
    }

    // Always mint a parallel ai-skills invocation. Sandbox forwards this to the
    // ai-skills service when tools (e.g. publish/delete capsules) need it.
    // Mint unconditionally for every authenticated MCP call — the per-(user,service)
    // cache inside createServiceInvocation makes repeat calls cheap. If minting
    // fails (no signing key, no cached delegation, did:web unresolved), we just
    // skip the header; sandbox tools that need it will surface a clean error.
    // SKILLS_CAPSULES_BASE_URL has a default in the env Zod schema, so a plain
    // get() is safe and avoids silently swallowing a misconfiguration throw.
    const skillsHeader = await mintInvocationHeader({
      ucanService,
      serviceUrl:
        configService.get('SKILLS_CAPSULES_BASE_URL') ??
        'https://capsules.skills.ixo.earth',
      userDid: configurable.configs.user.did,
      resource: 'ixo:skills',
      headerName: 'X-Skills-Invocation',
      successLogContext:
        '[UCAN] Attached X-Skills-Invocation header for sandbox',
      failureLogContext:
        '[UCAN] Failed to create skills invocation, omitting X-Skills-Invocation header',
    });
    sandboxHeaders = { ...sandboxHeaders, ...skillsHeader };
  }

  // Create sandbox MCP with auth headers (for tool schema discovery)
  const hasSandboxAuth =
    (configurable.configs?.user.matrixOpenIdToken && oracleOpenIdToken) ||
    sandboxHeaders['X-Auth-Type'] === 'ucan';
  const sandboxMCP = hasSandboxAuth
    ? createMCPClient({
        mcpServers: {
          sandbox: {
            type: 'http',
            url: configService.getOrThrow('SANDBOX_MCP_URL'),
            transport: 'http',
            headers: sandboxHeaders,
          },
        },
        defaultToolTimeout: 180_000,
      })
    : undefined;

  // Build memory engine headers — UCAN first, Matrix fallback
  const memoryMatrixFallbackHeaders: Record<string, string> = {
    'x-oracle-token': oracleOpenIdToken ?? '',
    'x-user-token': configurable.configs?.user.matrixOpenIdToken ?? '',
    'x-oracle-matrix-homeserver': oracleMatrixBaseUrl.replace(
      /^https?:\/\//,
      '',
    ),
    'x-user-matrix-homeserver':
      configurable.configs?.matrix.homeServerName ?? '',
    'x-room-id': matrix?.roomId ?? '',
    'User-Agent': 'LangChain-MCP-Client/1.0',
  };

  let memoryHeaders: Record<string, string> = memoryMatrixFallbackHeaders;

  if (ucanService?.hasSigningKey() && configurable.configs?.user?.did) {
    try {
      const memoryInvocation = await ucanService.createServiceInvocation(
        configService.getOrThrow('MEMORY_MCP_URL'),
        configurable.configs.user.did,
        'ixo:memory',
      );
      if (memoryInvocation) {
        memoryHeaders = {
          Authorization: `Bearer ${memoryInvocation}`,
          'X-Auth-Type': 'ucan',
          'x-room-id': matrix?.roomId ?? '',
          'User-Agent': 'LangChain-MCP-Client/1.0',
        };
        Logger.log('[UCAN] Using UCAN invocation for memory engine auth');
      }
    } catch (err) {
      Logger.warn(
        `[Memory MCP UCAN] Failed to create invocation, falling back to Matrix auth: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (ucanService) {
    // ucanService exists but hasSigningKey is false or userDid is missing
    Logger.warn(
      `[Memory MCP UCAN] Skipped — hasSigningKey=${ucanService.hasSigningKey()}, userDid=${configurable.configs?.user?.did ?? 'missing'}`,
    );
  }

  // Build Composio UCAN invocation token.
  // Audience = composio-worker DID (resolved from COMPOSIO_BASE_URL/.well-known/did.json).
  // Proofs = [user→oracle delegation]. The worker extracts userDid + oracleDid
  // from the invocation and builds a composite session user_id.
  let composioUcan: string | undefined;

  if (ucanService?.hasSigningKey() && configurable.configs?.user?.did) {
    try {
      const composioBaseUrl = configService.getOrThrow('COMPOSIO_BASE_URL');

      const invocation = await ucanService.createServiceInvocation(
        composioBaseUrl,
        configurable.configs.user.did,
        'ixo:sandbox',
      );
      if (invocation) {
        composioUcan = invocation;
        Logger.log('[UCAN] Using UCAN invocation for Composio auth');
      }
    } catch (err) {
      Logger.warn(
        `[UCAN] Failed to create Composio invocation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Build sandbox upload config for file processing (HTTP upload, no MCP needed)
  // Upload still uses Matrix OpenID tokens (UCAN upload support TODO)
  const sandboxUploadConfig: SandboxUploadConfig | undefined =
    configurable.configs?.user.matrixOpenIdToken && oracleOpenIdToken
      ? {
          sandboxMcpUrl: configService.getOrThrow('SANDBOX_MCP_URL'),
          userToken: configurable.configs.user.matrixOpenIdToken,
          oracleToken: oracleOpenIdToken,
          homeServerName: configurable.configs.matrix.homeServerName,
          oracleHomeServerUrl: oracleMatrixBaseUrl.replace(/^https?:\/\//, ''),
        }
      : undefined;

  Logger.log(`msgFromMatrixRoom: ${msgFromMatrixRoom}`);

  // Extract timezone and current time from config
  const userConfig = configurable?.configs?.user;
  const timezone = userConfig?.timezone;
  const currentTime = userConfig?.currentTime;

  // Format time context
  const timeContext = formatTimeContext(timezone, currentTime);

  if (!configurable?.configs?.user?.did) {
    throw new Error('User DID is required');
  }
  if (!configurable.thread_id) {
    throw new Error('Thread ID is required');
  }

  const agActionTools =
    state.agActions && state.agActions.length > 0
      ? state.agActions.map((action) => parserActionTool(action))
      : [];

  // Build AG-UI sub-agent when actions are available
  const aguiAgentSpec =
    agActionTools.length > 0
      ? createAguiAgent({
          tools: agActionTools,
          userDid: configurable.configs.user.did,
          sessionId: configurable.thread_id,
        })
      : null;

  // Create MCP tools - use UCAN-wrapped version if service is available
  const getMcpTools = async () => {
    // TODO: plan thoroughly if it is even wanted on mcp level
    // if (ucanService) {
    //   // Use UCAN-wrapped tools that validate invocations
    //   return createMCPClientAndGetToolsWithUCAN(
    //     ucanService,
    //     () => state.mcpUcanContext,
    //   );
    // }
    // Fallback to non-UCAN tools
    return createMCPClientAndGetTools();
  };

  // Build operational mode + editor section via JS — cleaner than nested mustache conditionals
  const editorPrompts = state.editorRoomId
    ? EDITOR_MODE_PROMPTS
    : state.spaceId
      ? STANDALONE_EDITOR_PROMPTS
      : null;

  const taskExecCtx = (configurable as Record<string, unknown>)
    .taskExecutionContext as TaskExecutionContext | undefined;

  const operationalMode = taskExecCtx
    ? [
        `**Autonomous Task Execution Mode**`,
        ``,
        `You are running a scheduled task autonomously — no human is in the loop. The user message contains a Task Page that is your **complete blueprint**. You MUST follow this exact 2-step sequence:`,
        ``,
        `## Step 1: Execute the Task`,
        `- Follow the Task Page exactly — execute "What to Do", format per "How to Report", obey "Constraints".`,
        `- If a step fails, check "Notes" for fallbacks before improvising. If the page is missing critical sections, report failure instead of guessing.`,
        `- Do not ask questions or narrate. Deliver only the requested output.`,
        ``,
        `### Tool Preferences`,
        `- **API calls / JSON data**: ALWAYS use the Sandbox (write a fetch/curl/requests script). NEVER use Firecrawl for API endpoints (/api/, /v1/, /v2/, /v3/, JSON responses).`,
        `- **Web scraping (human-readable pages)**: Use the Firecrawl Agent for scraping articles, blogs, news pages.`,
        `- **Web search**: Use the Firecrawl Agent's search tool for quick web searches.`,
        `- **Memory**: Use the Memory Agent to recall prior knowledge before external lookups.`,
        ``,
        `## Step 2: Execution Report (REQUIRED)`,
        `After producing your output, you MUST review your execution before finishing:`,
        ``,
        `1. **Task Page Notes** — Use the editor to append to "Notes" under "### Run #${taskExecCtx.runNumber} Learnings":`,
        `   - If issues occurred (API failures, retries, fallbacks, unexpected data): document each one concisely.`,
        `   - If everything was smooth: write "No issues encountered."`,
        `   Do NOT overwrite existing notes.`,
        `2. **Memory Engine** — Use the Memory Agent to store any cross-task learnings that could benefit future tasks (e.g., "API X rate-limits at 10 req/min", "Website Y needs JS rendering").`,
      ].join('\n')
    : editorPrompts
      ? editorPrompts.operationalMode
      : state.currentEntityDid
        ? [
            `**Entity Context Active**`,
            ``,
            `You are currently viewing an entity (DID: ${state.currentEntityDid}). Use:`,
            `- **Domain Indexer Agent** for entity discovery, overviews, and FAQs`,
            `- **Portal Agent** for navigation or UI actions (e.g., \`showEntity\`)`,
            `- **Memory Agent** for historical knowledge`,
            `For entities like ecs, supamoto, ixo, QI, use both Domain Indexer and Memory Agent together.`,
            ``,
            `**Important:** Pages (BlockNote documents) are NOT entities. For pages, use \`list_workspace_pages\` and \`call_editor_agent\` — never the Domain Indexer.`,
          ].join('\n')
        : [
            `**General Conversation Mode**`,
            ``,
            `Default to conversation mode, using the Memory Agent for recall and the Firecrawl Agent for external research or fresh data.`,
            ``,
            `### Tool Preferences`,
            `- **API calls / JSON data**: ALWAYS use the Sandbox (write a fetch/curl/requests script). NEVER use Firecrawl for API endpoints.`,
            `- **Web scraping (human-readable pages)**: Use the Firecrawl Agent for articles, blogs, news.`,
            `- **Web search**: Use the Firecrawl Agent's search tool.`,
            ``,
            `### Task Trial Runs`,
            `When the Task Manager asks you to do a trial run for a scheduled task, you are testing the work so the user can approve it. After completing the work:`,
            `1. Show the user the result as requested.`,
            `2. **Report your execution trace** — list every agent, URL, API endpoint (with params), search query, skill (name + CID), and the step-by-step order. Mention any failures or fallbacks.`,
            `This trace is critical — the Task Manager uses it to write a detailed task page for autonomous runs.`,
          ].join('\n');

  const editorSection = editorPrompts?.editorSection ?? '';

  // Track MCP/agent failures so the agent knows which capabilities are degraded
  const unavailableServices: string[] = [];

  /** Extract a value from a settled result, logging and tracking failures. */
  const settled = <T>(
    result: PromiseSettledResult<T>,
    fallback: T,
    name: string,
  ): T => {
    if (result.status === 'fulfilled') return result.value;
    Logger.error(
      `[createMainAgent] ${name} failed to initialize: ${String(result.reason)}`,
    );
    unavailableServices.push(name);
    return fallback;
  };

  const [
    portalResult,
    memoryResult,
    firecrawlResult,
    domainIndexerResult,
    mcpToolsResult,
    sandboxResult,
    taskManagerResult,
    composioResult,
  ] = await Promise.allSettled([
    createPortalAgent({
      tools:
        state.browserTools?.map((tool) =>
          parserBrowserTool({
            description: tool.description,
            schema: tool.schema,
            toolName: tool.name,
          }),
        ) ?? [],
      userDid: configurable.configs.user.did,
      sessionId: configurable.thread_id,
    }),
    createMemoryAgent({
      headers: memoryHeaders,
      mode: 'user',
      userDid: configurable.configs.user.did,
      sessionId: configurable.thread_id,
    }),
    createFirecrawlAgent({
      userDid: configurable.configs.user.did,
      sessionId: configurable.thread_id,
    }),
    createDomainIndexerAgent({
      userDid: configurable.configs.user.did,
      sessionId: configurable.thread_id,
    }),
    getMcpTools(),
    sandboxMCP?.getTools() ?? Promise.resolve([]),
    matrix?.roomId && tasksService && userMatrixId
      ? createTaskManagerAgent({
          tasksService,
          mainRoomId: matrix.roomId,
          userDid: configurable.configs.user.did,
          matrixUserId: userMatrixId,
          sessionId: configurable.thread_id,
          timezone: timezone ?? 'UTC',
          spaceId: state.spaceId,
        })
      : Promise.resolve(null),
    getComposioTools(configurable.configs.user.did, composioUcan),
  ]);

  const portalAgent = settled(portalResult, null, 'Portal Agent');
  const memoryAgent = settled(
    memoryResult,
    null,
    'Memory Agent (memory-engine MCP)',
  );
  const firecrawlAgent = settled(
    firecrawlResult,
    null,
    'Firecrawl Agent (firecrawl MCP)',
  );
  const domainIndexerAgent = settled(
    domainIndexerResult,
    null,
    'Domain Indexer Agent',
  );
  const mcpTools = settled(mcpToolsResult, [], 'MCP tools');
  const sandboxTools = settled(sandboxResult, [], 'Sandbox MCP');
  const taskManagerAgent = settled(
    taskManagerResult,
    null,
    'Task Manager Agent',
  );
  const composioTools = settled(composioResult, [], 'Composio tools');

  // System prompt — built after Promise.allSettled so COMPOSIO_CONTEXT
  // is populated only when Composio tools actually loaded.
  //
  // The prompt is split into two halves:
  //   - Oracle section (top): identity, persona, domain capabilities, communication
  //     style — driven by oracle.config.json `prompt.*` fields, with defaults when absent.
  //   - Base section (template body): skills system, routing, sub-agents, memory,
  //     user context — always the same regardless of oracle config.
  const configPrompt = oracleConfig.prompt;
  const systemPrompt = await AI_ASSISTANT_PROMPT.format({
    ORACLE_SECTION: buildOracleSection({
      // Prefer the user's chosen agent name when set, otherwise fall back to
      // the configured oracle name.
      oracleName:
        userPreferences?.agentName ??
        oracleConfig.oracleName ??
        configService.get('ORACLE_NAME') ??
        'Oracle',
      orgName: oracleConfig.orgName || undefined,
      description: oracleConfig.description || undefined,
      location: oracleConfig.location || undefined,
      prompt: configPrompt,
    }),
    IDENTITY_CONTEXT: formatUserContext(state?.userContext?.identity),
    WORK_CONTEXT: formatUserContext(state?.userContext?.work),
    GOALS_CONTEXT: formatUserContext(state?.userContext?.goals),
    INTERESTS_CONTEXT: formatUserContext(state?.userContext?.interests),
    RELATIONSHIPS_CONTEXT: formatUserContext(state?.userContext?.relationships),
    RECENT_CONTEXT: formatUserContext(state?.userContext?.recent),
    TIME_CONTEXT: timeContext,
    CURRENT_ENTITY_DID: state.currentEntityDid ?? '',
    OPERATIONAL_MODE: operationalMode,
    EDITOR_SECTION: editorSection,
    SLACK_FORMATTING_CONSTRAINTS:
      state.client === 'slack' ? SLACK_FORMATTING_CONSTRAINTS_CONTENT : '',
    USER_SECRETS_CONTEXT:
      secretIndex.length > 0
        ? secretIndex.map((s) => `- _USER_SECRET_${s.name}`).join('\n')
        : '',
    COMPOSIO_CONTEXT: composioTools.length > 0 ? COMPOSIO_CONTEXT : '',
    USER_PREFERENCES_CONTEXT: formatUserPreferences(userPreferences),
  });

  // Wrap sandbox_run for lazy secret injection (both oracle and user secrets).
  // MCP adapters snapshot headers at construction time, so we create a new
  // MCP client with all secrets on first sandbox_run call.
  let enrichedRunTool: (typeof sandboxTools)[number] | null = null;
  let enrichedRunPromise: Promise<void> | null = null;

  const wrappedSandboxTools = sandboxTools.map((t) => {
    if (t.name !== 'sandbox_run') return t;

    return new DynamicStructuredTool({
      name: t.name,
      description: t.description,
      schema: t.schema,
      func: async (input) => {
        // Lazily create enriched MCP client on first sandbox_run call (promise-safe)
        if (!enrichedRunPromise) {
          enrichedRunPromise = (async () => {
            const enrichedHeaders = { ...sandboxHeaders };

            // Add oracle secrets as x-os-* headers
            const oracleSecretsStr = configService.get('ORACLE_SECRETS', '');
            if (oracleSecretsStr) {
              for (const pair of oracleSecretsStr.split(',')) {
                const eqIdx = pair.indexOf('=');
                if (eqIdx > 0) {
                  const key = pair.slice(0, eqIdx).trim();
                  const val = pair.slice(eqIdx + 1).trim();
                  if (key && val)
                    enrichedHeaders[`x-os-${key.toLowerCase()}`] = val;
                }
              }
            }

            // Add user secrets as x-us-* headers
            if (secretIndex.length > 0 && roomId) {
              const values =
                await SecretsService.getInstance().loadSecretValues(
                  roomId,
                  secretIndex,
                );
              for (const [name, value] of Object.entries(values)) {
                enrichedHeaders[`x-us-${name.toLowerCase()}`] = value;
              }
            }

            const enrichedMCP = createMCPClient({
              mcpServers: {
                sandbox: {
                  type: 'http',
                  url: configService.getOrThrow('SANDBOX_MCP_URL'),
                  transport: 'http',
                  headers: enrichedHeaders,
                },
              },
              defaultToolTimeout: 180_000,
            });
            const enrichedTools = (await enrichedMCP?.getTools()) ?? [];
            enrichedRunTool =
              enrichedTools.find((et) => et.name === 'sandbox_run') ?? null;
          })();
        }

        await enrichedRunPromise;

        if (enrichedRunTool) {
          return enrichedRunTool.invoke(input);
        }
        // Fallback to original tool (without secrets)
        return t.invoke(input);
      },
    });
  });

  // sandbox_write_blob — companion to mint_invocation. Takes a blobId
  // (server-side stored long string) and a sandbox path; looks up the blob
  // in the BlobStore and calls the underlying sandbox_write_file MCP tool
  // with the value. The LLM only ever passes the short blobId + path —
  // long base64 strings (UCAN CARs etc.) never enter its context, so they
  // can't be corrupted in transit.
  const userDidForBlob = configurable.configs?.user?.did ?? '';
  const sandboxWriteFileTool = wrappedSandboxTools.find(
    (t) => t.name === 'sandbox_write_file',
  );
  let sandboxWriteBlobTool: StructuredTool | null = null;
  if (blobStore && sandboxWriteFileTool && userDidForBlob) {
    sandboxWriteBlobTool = new DynamicStructuredTool({
      name: 'sandbox_write_blob',
      description: `Write a server-stored blob to a file in the sandbox without ever paste-relaying the value through the LLM.

Use this whenever a tool returns a \`blobId\` (e.g. \`mint_invocation\`'s response). Pass the blobId + the destination path; the runtime looks the value up server-side and calls sandbox_write_file with its content. The long opaque value (base64 CARs, JWTs, etc.) never enters the LLM context — eliminates string-corruption-in-relay as a failure mode.

Inputs:
  - blobId: short hex identifier returned by the producing tool (format \`blob_<16 hex chars>\`).
  - path: destination path in the sandbox. Must be under \`/workspace/data/\` (the sandbox enforces this; writes elsewhere are rejected).

Returns: \`{ success: true, path, bytesWritten }\` on success, \`{ success: false, error }\` on failure. Common errors: blob not found (re-mint and retry — for invocations this can happen on a multi-replica deployment if the lookup lands on a different process), invalid blobId format, path outside /workspace/data/.`,
      schema: z.object({
        blobId: z
          .string()
          .describe(
            'The blobId returned by the tool that produced the value (e.g. mint_invocation). Format: `blob_<16 hex chars>`.',
          ),
        path: z
          .string()
          .describe(
            'Destination path in the sandbox, e.g. `/workspace/data/<skill>/ucan_token`. Must be under /workspace/data/.',
          ),
      }),
      func: async ({ blobId, path }) => {
        if (!blobStore.isValidBlobId(blobId)) {
          return JSON.stringify({
            success: false,
            error: `Invalid blobId format. Expected blob_<16 hex chars>, got "${blobId}".`,
          });
        }
        if (typeof path !== 'string' || !path.startsWith('/workspace/data/')) {
          return JSON.stringify({
            success: false,
            error: `path must be under /workspace/data/. Got: "${path}".`,
          });
        }
        const blob = await blobStore.get({ userDid: userDidForBlob, blobId });
        if (!blob) {
          return JSON.stringify({
            success: false,
            error: `Blob "${blobId}" not found (expired, never existed, or owned by another user). Re-mint and retry — for single-use invocations this is expected if the blob's TTL elapsed.`,
          });
        }

        try {
          const result = await sandboxWriteFileTool.invoke({
            path,
            content: blob.value,
            encoding: 'utf8',
          });
          return JSON.stringify({
            success: true,
            path,
            bytesWritten: blob.value.length,
            blobName: blob.name,
            note: typeof result === 'string' ? result : undefined,
          });
        } catch (err) {
          return JSON.stringify({
            success: false,
            error: `sandbox_write_file failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      },
    });
    Logger.log('📦 Created sandbox_write_blob tool');
  }

  // Reuse the ixo:skills invocation already minted for sandbox forwarding.
  // Listing/search tools forward this directly to ai-skills so the user's
  // own private (published) skills surface alongside the public registry.
  // Undefined when UCAN is unavailable — the listing tools degrade to
  // public-only.
  const skillsUcan: string | undefined = sandboxHeaders['X-Skills-Invocation'];

  const listSkillsTool = createListSkillsTool({ skillsUcan });
  const searchSkillsTool = createSearchSkillsTool({ skillsUcan });
  // `mint_invocation` lives on the editor agent (it needs Y.Doc access to
  // resolve a delegationCid → CAR without round-tripping the long base64
  // string through the LLM). The main agent reaches it via call_editor_agent;
  // it's listed in that subagent tool's `forwardTools` so the call/result
  // surface in the main stream as native tool events.
  const mintInvocationCapable = !!(ucanService && ucanService.hasSigningKey());

  // Conditionally create BlockNote (editor) agent tool if editorRoomId is provided
  let blockNoteAgentSpec:
    | Awaited<ReturnType<typeof createEditorAgent>>
    | undefined;
  if (state.editorRoomId) {
    Logger.log(`Editor room ID provided: ${state.editorRoomId}`);
    Logger.log('Initializing BlockNote tools...');

    try {
      blockNoteAgentSpec = await createEditorAgent({
        room: state.editorRoomId,
        mode: 'edit',
        userMatrixId,
        spaceId: state.spaceId,
        memoryAuth: pageMemoryAuth,
        ucanService: mintInvocationCapable ? ucanService : undefined,
        blobStore,
        userDid: configurable.configs.user.did,
        sessionId: configurable.thread_id,
      });
    } catch (error) {
      Logger.error(
        `[createMainAgent] Editor Agent failed to initialize: ${String(error)}`,
      );
      unavailableServices.push('Editor Agent');
    }
  }

  // Helper to inject time context into sub-agent system prompts
  const withTimeContext = (spec: AgentSpec): AgentSpec => ({
    ...spec,
    systemPrompt: `${spec.systemPrompt}\n\n## Current Time\n${timeContext}`,
  });

  // Create standalone editor tool when spaceId is present but no editor session.
  // Accepts a room_id per call, spinning up an ephemeral editor agent with full
  // BlockNote capabilities for that page.
  let standaloneEditorTool: StructuredTool | null = null;
  if (!state.editorRoomId && state.spaceId) {
    const userDid = configurable?.configs?.user?.did;
    const homeServer = configurable?.configs?.matrix?.homeServerName;
    const standaloneUserMatrixId =
      userDid && homeServer
        ? `@${userDid.replace(/:/g, '-')}:${homeServer}`
        : undefined;

    standaloneEditorTool = createStandaloneEditorTool({
      userMatrixId: standaloneUserMatrixId,
      spaceId: state.spaceId,
      memoryAuth: pageMemoryAuth,
      transformSpec: withTimeContext,
      ucanService: mintInvocationCapable ? ucanService : undefined,
      blobStore,
      userDid: configurable.configs.user.did,
      sessionId: configurable.thread_id,
    });

    Logger.log(`Created standalone editor tool with spaceId: ${state.spaceId}`);
  }

  // Create apply_sandbox_output_to_block tool when both sandbox and editor are available
  let applySandboxOutputToBlockTool: ReturnType<
    typeof createApplySandboxOutputToBlockTool
  > | null = null;
  if (state.editorRoomId) {
    const sandboxRunTool = wrappedSandboxTools.find(
      (t) => t.name === 'sandbox_run',
    );
    if (sandboxRunTool) {
      applySandboxOutputToBlockTool = createApplySandboxOutputToBlockTool({
        sandboxRunTool,
        editorRoomId: state.editorRoomId,
      });
      Logger.log('📦 Created apply_sandbox_output_to_block tool');
    }
  }

  const callPortalAgentTool = portalAgent
    ? createSubagentAsTool(withTimeContext(portalAgent))
    : null;
  const callMemoryAgentTool = memoryAgent
    ? createSubagentAsTool(withTimeContext(memoryAgent))
    : null;
  const callFirecrawlAgentTool = firecrawlAgent
    ? createSubagentAsTool(withTimeContext(firecrawlAgent))
    : null;
  const callDomainIndexerAgentTool = domainIndexerAgent
    ? createSubagentAsTool(withTimeContext(domainIndexerAgent))
    : null;
  const callAguiAgentTool = aguiAgentSpec
    ? createSubagentAsTool(withTimeContext(aguiAgentSpec), {
        forwardTools: agActionTools.map((t) => t.name),
      })
    : null;
  const callEditorAgentTool = blockNoteAgentSpec
    ? createSubagentAsTool(withTimeContext(blockNoteAgentSpec), {
        forwardTools: [
          'create_page',
          'update_page',
          'edit_block',
          'create_block',
          'mint_invocation',
        ],
        onComplete: pageMemoryAuth
          ? (messages, task) =>
              logEditorSessionToMemory(
                pageMemoryAuth,
                messages,
                state.editorRoomId!,
                task,
              )
          : undefined,
      })
    : null;
  const callTaskManagerAgentTool = taskManagerAgent
    ? createSubagentAsTool(withTimeContext(taskManagerAgent), {
        forwardTools: [
          'create_task',
          'list_tasks',
          'get_task_status',
          'set_approval_gate',
          'pause_task',
          'resume_task',
          'cancel_task',
          'update_task_schedule',
        ],
      })
    : null;

  let finalSystemPrompt = systemPrompt;
  if (unavailableServices.length > 0) {
    const serviceList = unavailableServices.map((s) => `- ${s}`).join('\n');
    finalSystemPrompt += `\n\n---\n\n## DEGRADED SERVICES\n\nThe following services failed to initialize and are temporarily unavailable. Do NOT attempt to use their tools — they will not work. Inform the user if they request functionality that depends on these services and suggest they try again later.\n\n${serviceList}\n`;
    Logger.warn(
      `[createMainAgent] ${unavailableServices.length} service(s) unavailable: ${unavailableServices.join(', ')}`,
    );
  }

  // Group-chat awareness: when MessagesService detects a group room it
  // attaches a pre-built context block to runnableConfig.configurable.
  // The roomId itself already lives on configurable.configs.matrix.roomId
  // (in `matrix?.roomId` above) — no need to duplicate.
  const configurableExt = configurable as Record<string, unknown>;
  const groupChatContext =
    typeof configurableExt.groupChatContext === 'string'
      ? configurableExt.groupChatContext
      : undefined;
  const isGroupRoom = Boolean(groupChatContext);

  if (groupChatContext) {
    finalSystemPrompt += `\n\n---\n\n## GROUP CHAT CONTEXT\n\n${groupChatContext}\n`;
  }

  const channelMemoryService = ChannelMemoryService.getInstance();
  const channelMemoryTools =
    isGroupRoom && matrix?.roomId && channelMemoryService
      ? createChannelMemoryTools({
          channelMemory: channelMemoryService,
          roomId: matrix.roomId,
          pinnedByDid: configurable.configs?.user?.did ?? '',
        })
      : [];

  // check db folder if not exists, create it
  const dbFolder = path.join(
    UserMatrixSqliteSyncService.checkpointsFolder,
    configurable?.configs?.user?.did,
  );
  if (!fs.existsSync(dbFolder)) {
    fs.mkdirSync(dbFolder, { recursive: true });
  }

  // Build middleware list conditionally
  const disableCredits = configService.get('DISABLE_CREDITS');

  const middleware = [
    createToolValidationMiddleware(),
    toolRetryMiddleware({ onFailure: (error) => error.message }),
    createPageContextMiddleware(),
  ];

  if (!disableCredits && isRedisEnabled()) {
    middleware.push(createTokenLimiterMiddleware());
  }

  // Priority: caller override → oracle.config model → default llm
  const effectiveModel = modelOverride
    ? getProviderChatModel('main', { model: modelOverride })
    : oracleConfig.model
      ? getProviderChatModel('main', { model: oracleConfig.model })
      : llm;

  const agent = createAgent({
    model: effectiveModel,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contextSchema: contextSchema as any,
    tools: [
      ...mcpTools,
      ...composioTools,
      ...wrappedSandboxTools,
      ...(callAguiAgentTool ? [callAguiAgentTool] : []),
      listSkillsTool,
      searchSkillsTool,
      ...(callPortalAgentTool ? [callPortalAgentTool] : []),
      ...(callMemoryAgentTool ? [callMemoryAgentTool] : []),
      ...(callFirecrawlAgentTool ? [callFirecrawlAgentTool] : []),
      ...(callDomainIndexerAgentTool ? [callDomainIndexerAgentTool] : []),
      ...(callEditorAgentTool ? [callEditorAgentTool] : []),
      ...(callTaskManagerAgentTool ? [callTaskManagerAgentTool] : []),
      ...(fileProcessingService
        ? [
            createFileProcessingTool(
              fileProcessingService,
              matrix?.roomId,
              sandboxUploadConfig,
            ),
          ]
        : []),
      ...(matrix?.roomId
        ? [
            createListRoomFilesTool(matrix.roomId),
            createSetUserPreferencesTool(matrix.roomId),
          ]
        : []),
      ...channelMemoryTools,
      ...(applySandboxOutputToBlockTool ? [applySandboxOutputToBlockTool] : []),
      ...(sandboxWriteBlobTool ? [sandboxWriteBlobTool] : []),
      ...(standaloneEditorTool ? [standaloneEditorTool] : []),
    ],
    middleware,
    stateSchema: z.object({
      editorRoomId: z.string().optional(),
    }),
    systemPrompt: finalSystemPrompt,
    checkpointer: SqliteSaver.fromDatabase(
      await UserMatrixSqliteSyncService.getInstance().getUserDatabase(
        configurable?.configs?.user?.did,
      ),
    ),
    name: 'Companion Agent',
  });

  return agent;
};

// Helper function to format time context
const formatTimeContext = (
  timezone: string | undefined,
  currentTime: string | undefined,
): string => {
  if (!timezone && !currentTime) {
    return 'Not available.';
  }

  let context = '';

  if (currentTime) {
    context += `Current local time: ${currentTime}`;
  }

  if (timezone) {
    if (context) {
      context += `\nTimezone: ${timezone}`;
    } else {
      context += `Timezone: ${timezone}`;
    }
  }

  return context || 'Not available.';
};
