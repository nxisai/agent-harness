/**
 * Connects an MCP client to a discovered server over Streamable HTTP.
 *
 * @module
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerInfo } from '../../types.js';

/** Open an initialized MCP session to `info.endpoint`. Pass `apiKey` only for
 * private tools. Public typed retrieval needs no credential. */
export async function connectMcp(info: McpServerInfo, apiKey?: string): Promise<Client> {
  const headers: Record<string, string> = {};
  if (apiKey && info.authHeaderName) headers[info.authHeaderName] = apiKey;

  const transport = new StreamableHTTPClientTransport(new URL(info.endpoint), {
    requestInit: { headers },
  });

  const client = new Client(
    { name: 'nxisai-browser-agent', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}
