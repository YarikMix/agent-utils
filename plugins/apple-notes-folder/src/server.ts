import { VERSION } from './version.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toToolResult, reportAttachmentCleanupFailure } from './errors.js';
import { homedir } from 'node:os';
import { cleanupRuntime, makeImagePreparer } from './attachments/tickets.js';
import { readFolder } from './hosts/config.js';
import { configurationHint, hostPaths, parseHost } from './hosts/paths.js';
import { makeOsascriptRunner } from './runner.js';
import { makeScopeProvider } from './scope.js';
import { makeTools } from './tools.js';

const host = parseHost(process.argv.slice(2));
const hint = configurationHint(host);
const paths = hostPaths(host, process.env, homedir());
const run = makeOsascriptRunner(undefined, hint);
// Best-effort maintenance on each MCP start, independent of Notes operations.
try { await cleanupRuntime(paths); } catch { reportAttachmentCleanupFailure(); }
// Capture configuration once. A malformed config remains a tool-level error until restart.
let getScope: ReturnType<typeof makeScopeProvider>;
try { getScope = makeScopeProvider(await readFolder(host, process.env, homedir()), run, hint); }
catch (error) { getScope = async () => { throw error; }; }

const server = new McpServer({ name: 'apple-notes-folder', version: VERSION });

for (const tool of makeTools({ getScope, run, prepareImages: makeImagePreparer(host, paths) })) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.shape, annotations: tool.annotations },
    async (args: unknown) => {
      try {
        return { content: [{ type: 'text' as const, text: await tool.handler(args) }] };
      } catch (e) {
        return toToolResult(e);
      }
    },
  );
}

// Папка ищется сразу при старте; неудача не роняет сервер — инструменты повторят попытку.
getScope().catch(() => {});

await server.connect(new StdioServerTransport());
