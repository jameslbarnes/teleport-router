/** While the enclave's keys disagree with their pins, only these existing reads run.
 * Default closed: new HTTP routes, custom MCP tools and mixed read/write actions wait for recovery. */
export const KEY_RECOVERY_MESSAGE = 'Router is read-only while its storage keys are being recovered. You can search available notes and read your posting rules. Notes stored in TinyCloud and waiting notes are unavailable.';

const readPaths = new Set([
  '/', '/index.html', '/docs', '/docs.html', '/entry.html', '/router.css', '/favicon.svg', '/safe-html.js', '/sharing-notice.js',
  '/api/entries', '/api/search', '/api/conversations', '/api/posting-rules', '/api/posting-rules-guide',
  '/api/channels', '/api/inbox',
]);

export function recoveryAllowsRequest(method: string | undefined, path: string): boolean {
  // MCP uses POST for reads. Its tool handler checks each call, including calls on existing sessions.
  if (path === '/mcp/http') return method === 'POST' || method === 'GET' || method === 'DELETE';
  if (path === '/mcp/sse') return method === 'GET';
  if (path === '/mcp/messages') return method === 'POST';
  if (path === '/api/identity/lookup') return method === 'POST';
  if (method !== 'GET') return false;
  return readPaths.has(path) || /^\/e\/[\w-]+$/.test(path)
    || /^\/api\/entry\/[\w-]+(?:\/replies)?$/.test(path)
    || /^\/api\/entries\/[\w%-]+$/.test(path)
    || /^\/api\/channels\/[\w-]+(?:\/entries)?$/.test(path)
    || /^\/(?:scripts|styles|assets\/fonts|vendor)\/[\w.-]+\.(?:js|css|woff2?)$/.test(path);
}

export function recoveryAllowsTool(name: string, args?: Record<string, unknown>): boolean {
  return name === 'router_search' || name === 'router_get_entry'
    || (name === 'router_posting_rules' && (args?.action === undefined || args.action === 'get'));
}
