/**
 * Resolves a site's MCP server from its `.well-known` catalogs.
 *
 * Reads `/.well-known/ai-catalog.json` (falling back to `mcp/catalog.json`,
 * the MCP-specific catalog NxisAI publishes beside it),
 * follows an entry's URL to the server card, and extracts the Streamable HTTP
 * endpoint, its auth header, and the tools available without a key.
 *
 * @module
 */
import type { CatalogEntry, CatalogFile, McpServerInfo, ServerCard } from '../../types.js';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The catalog entry for the MCP server card.
 *
 * A catalog can list more than the MCP server: an A2A Agent Card for a
 * handoff target, say. An entry typed as an MCP server card wins; an entry
 * typed as anything else is never taken for one; an untyped entry is taken
 * only when nothing is typed, as older catalogs have no types at all.
 *
 * @returns The entry, or undefined when the catalog lists no MCP server.
 */
export function mcpCatalogEntry(catalog: CatalogFile): CatalogEntry | undefined {
  const entries = (catalog.entries ?? []).filter((e) => !!e.url);
  const typeOf = (e: CatalogEntry) => (e.type ?? e.mediaType ?? '').toLowerCase();
  const typed = entries.find((e) => /\bmcp\b|mcp-server/.test(typeOf(e)));
  if (typed) return typed;
  return entries.find((e) => !typeOf(e));
}

/** Find the server-card URL by reading the well-known catalogs in order. */
async function resolveServerCardUrl(): Promise<string> {
  const catalogs = ['/.well-known/ai-catalog.json', '/.well-known/mcp/catalog.json'];
  for (const path of catalogs) {
    try {
      const catalog = await fetchJson<CatalogFile>(path);
      const entry = mcpCatalogEntry(catalog);
      if (entry?.url) return entry.url;
    } catch {
      /* try the next catalog */
    }
  }
  throw new Error('No MCP server-card URL found in .well-known catalogs');
}

/** Discover the remote MCP server: card URL → endpoint, auth, public tools. */
export async function discoverMcpServer(): Promise<McpServerInfo> {
  const cardUrl = await resolveServerCardUrl();
  const card = await fetchJson<ServerCard>(cardUrl);

  const remote = card.remotes?.find((r) => r.type === 'streamable-http') ?? card.remotes?.[0];
  if (!remote?.url) throw new Error(`Server card at ${cardUrl} has no remote endpoint URL`);

  const authHeader = remote.headers?.[0];
  const meta = card._meta ?? {};
  const publicTools = (meta['ai.nxis/publicTools'] as string[] | undefined) ?? [];

  return {
    endpoint: remote.url,
    authHeaderName: authHeader?.name,
    authRequired: authHeader?.isRequired ?? false,
    publicTools,
    protocolVersions: remote.supportedProtocolVersions ?? [],
    cardUrl,
    title: card.title,
  };
}
