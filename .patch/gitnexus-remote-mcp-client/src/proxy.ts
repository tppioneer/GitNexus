import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CompatibleStdioServerTransport } from './transport.js';
import { HARDCODED_TOOLS } from './tools.js';

export interface ProxyServerOptions {
  remoteUrl: string;
}

class ReconnectingClient {
  private _client: Client | null = null;
  private _transport: StreamableHTTPClientTransport | null = null;
  private _serverVersion: { name: string; version: string } | null = null;
  private _serverCapabilities: { resources?: unknown; prompts?: unknown } | null = null;

  private _reconnectLock: Promise<void> | null = null;

  private _retryCount = 0;
  private static readonly MAX_RETRIES = 3;
  private static readonly INITIAL_DELAY_MS = 1_000;
  private static readonly MAX_DELAY_MS = 30_000;

  constructor(private readonly _remoteUrl: string) {}

  async connect(): Promise<void> {
    await this._doConnectWithRetry();
  }

  private async _doConnectWithRetry(): Promise<void> {
    this._retryCount = 0;
    await this._doConnect();
  }

  private async _doConnect(): Promise<void> {
    while (true) {
      try {
        this._transport = new StreamableHTTPClientTransport(new URL(this._remoteUrl));
        this._client = new Client(
          { name: 'gitnexus-remote-mcp-client', version: '1.0.0' },
          { capabilities: {} },
        );
        await this._client.connect(this._transport);

        this._serverVersion = this._client.getServerVersion() ?? null;
        this._serverCapabilities = (this._client.getServerCapabilities() ?? null) as any;
        return;
      } catch (error) {
        this._client = null;
        this._transport = null;

        if (this._retryCount >= ReconnectingClient.MAX_RETRIES) throw error;

        this._retryCount++;
        const delay = Math.min(
          ReconnectingClient.INITIAL_DELAY_MS * Math.pow(2, this._retryCount - 1),
          ReconnectingClient.MAX_DELAY_MS,
        );
        process.stderr.write(
          `gitnexus-remote-mcp-client: connection failed (attempt ${this._retryCount}/${ReconnectingClient.MAX_RETRIES}), retrying in ${delay}ms...\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private static _isTransientError(error: unknown): boolean {
    if (error instanceof StreamableHTTPError && error.code === 404) return true;

    if (error instanceof StreamableHTTPError && typeof error.code === 'number') {
      if ([502, 503, 504].includes(error.code)) return true;
    }

    const msg = error instanceof Error ? error.message : String(error);
    if (
      msg.includes('ECONNRESET') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('socket hang up') ||
      msg.includes('network error') ||
      msg.includes('fetch failed')
    ) {
      return true;
    }

    return false;
  }

  private async _withReconnect<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    if (!this._client) {
      await this._doConnectWithRetry();
    }

    try {
      return await fn(this._client!);
    } catch (error: unknown) {
      if (!ReconnectingClient._isTransientError(error)) throw error;

      if (this._reconnectLock) {
        await this._reconnectLock;
        try {
          return await fn(this._client!);
        } catch {
          throw error;
        }
      }

      let resolveLock: (() => void) | undefined;
      let rejectLock: ((err: unknown) => void) | undefined;
      this._reconnectLock = new Promise<void>((resolve, reject) => {
        resolveLock = resolve;
        rejectLock = reject;
      });

      try {
        process.stderr.write(
          'gitnexus-remote-mcp-client: remote connection lost, reconnecting...\n',
        );

        try {
          await this._transport?.close();
        } catch {}
        this._client = null;
        this._transport = null;

        await this._doConnectWithRetry();
        const result = await fn(this._client!);
        resolveLock!();
        return result;
      } catch (reconnectError) {
        rejectLock!(reconnectError);
        throw reconnectError;
      } finally {
        this._reconnectLock = null;
      }
    }
  }

  getServerVersion() {
    return this._serverVersion;
  }

  getServerCapabilities() {
    return this._serverCapabilities;
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    return this._withReconnect((client) => client.callTool(params as any));
  }

  async listResources() {
    return this._withReconnect((client) => client.listResources());
  }

  async listResourceTemplates() {
    return this._withReconnect((client) => client.listResourceTemplates());
  }

  async readResource(params: { uri: string }) {
    return this._withReconnect((client) => client.readResource(params));
  }

  async listPrompts() {
    return this._withReconnect((client) => client.listPrompts());
  }

  async getPrompt(params: { name: string; arguments?: Record<string, string> }) {
    return this._withReconnect((client) => client.getPrompt(params));
  }

  async close() {
    try {
      await this._transport?.close();
    } catch {}
    this._client = null;
    this._transport = null;
  }
}

export async function startProxyServer(options: ProxyServerOptions): Promise<void> {
  const { remoteUrl } = options;

  const origConsole = { ...console };
  const redirectToStderr = (method: string) => {
    return (...args: unknown[]) => {
      process.stderr.write(`[console.${method}] ` + args.map(String).join(' ') + '\n');
    };
  };
  console.log = redirectToStderr('log');
  console.info = redirectToStderr('info');
  console.debug = redirectToStderr('debug');
  console.warn = redirectToStderr('warn');
  console.error = redirectToStderr('error');

  const remote = new ReconnectingClient(remoteUrl);
  await remote.connect();

  const serverVersion = remote.getServerVersion();
  const serverCapabilities = remote.getServerCapabilities();

  const localServer = new Server(
    {
      name: serverVersion?.name
        ? `gitnexus-remote-mcp-client (${serverVersion.name})`
        : 'gitnexus-remote-mcp-client',
      version: serverVersion?.version ?? '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: serverCapabilities?.resources ? {} : undefined,
        prompts: serverCapabilities?.prompts ? {} : undefined,
      },
    },
  );

  // ─── Tool handlers ──────────────────────────────────────────────

  localServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: HARDCODED_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
    };
  });

  localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const toolDef = HARDCODED_TOOLS.find((t) => t.name === name);
    if (!toolDef) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: Unknown tool "${name}". Available tools: ${HARDCODED_TOOLS.map((t) => t.name).join(', ')}`,
        }],
        isError: true,
      };
    }

    try {
      const result = await remote.callTool({ name, arguments: args as Record<string, unknown> });
      return {
        content: result.content as any,
        isError: result.isError,
        _meta: result._meta,
      };
    } catch (error: any) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // ─── Resource handlers (transparent proxy) ──────────────────────

  if (serverCapabilities?.resources) {
    localServer.setRequestHandler(ListResourcesRequestSchema, async () => {
      const result = await remote.listResources();
      return { resources: result.resources };
    });

    localServer.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const result = await remote.listResourceTemplates();
      return { resourceTemplates: result.resourceTemplates };
    });

    localServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      try {
        const result = await remote.readResource({ uri });
        return { contents: result.contents as any };
      } catch (error: any) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          contents: [{ uri, mimeType: 'text/plain' as const, text: `Error: ${message}` }],
        };
      }
    });
  }

  // ─── Prompt handlers (transparent proxy) ────────────────────────

  if (serverCapabilities?.prompts) {
    localServer.setRequestHandler(ListPromptsRequestSchema, async () => {
      const result = await remote.listPrompts();
      return { prompts: result.prompts };
    });

    localServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await remote.getPrompt({ name, arguments: args as Record<string, string> });
      return {
        messages: result.messages as any,
        description: result.description,
      };
    });
  }

  // ─── Transport ──────────────────────────────────────────────────

  const transport = new CompatibleStdioServerTransport();

  const shutdown = async () => {
    try { await localServer.close(); } catch {}
    try { await remote.close(); } catch {}
    Object.assign(console, origConsole);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());

  if (process.stdin.readableEnded || (process.stdin as any).destroyed) {
    await shutdown();
    return;
  }

  await localServer.connect(transport);
}
