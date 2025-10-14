/**
 * MCP (Model Context Protocol) tools for acp-handler
 *
 * This module provides tool definitions and handlers to expose your acp-handler
 * checkout API as MCP tools for ChatGPT Apps. This allows merchants to sell
 * products through ChatGPT without waiting for ACP approval.
 *
 * ## Payment Handling
 *
 * MCP tools follow the same ACP protocol as the full ACP implementation, but with
 * a key difference: ChatGPT Apps don't provide delegated payment tokens. When
 * `completeCheckout` is called without a payment token, it returns a checkout URL
 * for the user to complete payment on your site (which can be loaded in the ChatGPT
 * iframe if desired).
 *
 * @example Basic usage (default checkout URL)
 * ```typescript
 * import { McpServer } from 'mcp-handler';
 * import { tools, createHandlers } from 'acp-handler/mcp';
 *
 * const server = new McpServer({ name: 'my-store' });
 * const handlers = createHandlers({
 *   baseUrl: 'https://mystore.com'
 *   // Defaults to: https://mystore.com/checkout/:sessionId
 * });
 *
 * // Register all tools
 * server.registerTool('search_products', tools.searchProducts, handlers.searchProducts);
 * server.registerTool('create_checkout', tools.createCheckout, handlers.createCheckout);
 * server.registerTool('complete_checkout', tools.completeCheckout, handlers.completeCheckout);
 *
 * server.start();
 * ```
 *
 * @example With custom checkout URL
 * ```typescript
 * import { McpServer } from 'mcp-handler';
 * import { tools, createHandlers } from 'acp-handler/mcp';
 *
 * const server = new McpServer({ name: 'my-store' });
 * const handlers = createHandlers({
 *   baseUrl: 'https://mystore.com',
 *   headers: { 'Authorization': 'Bearer secret' },
 *   getCheckoutUrl: (sessionId) => `https://mystore.com/buy/${sessionId}?source=chatgpt`
 * });
 *
 * // Register tools
 * server.registerTool('search_products', tools.searchProducts, handlers.searchProducts);
 * server.registerTool('create_checkout', tools.createCheckout, handlers.createCheckout);
 * server.registerTool('complete_checkout', tools.completeCheckout, handlers.completeCheckout);
 * ```
 *
 * @example With custom handler logic
 * ```typescript
 * import { McpServer } from 'mcp-handler';
 * import { tools, createHandlers } from 'acp-handler/mcp';
 *
 * const server = new McpServer({ name: 'my-store' });
 * const handlers = createHandlers({
 *   baseUrl: 'https://mystore.com',
 *   getCheckoutUrl: (sessionId) => `https://mystore.com/checkout/${sessionId}`
 * });
 *
 * // Customize tool definitions
 * server.registerTool(
 *   'search_products',
 *   {
 *     ...tools.searchProducts,
 *     description: 'Search our awesome product catalog!',
 *   },
 *   handlers.searchProducts
 * );
 *
 * // Or wrap handlers with custom logic
 * server.registerTool(
 *   'create_checkout',
 *   tools.createCheckout,
 *   async (input) => {
 *     console.log('Creating checkout:', input);
 *     const result = await handlers.createCheckout(input);
 *     return result;
 *   }
 * );
 * ```
 *
 * @module mcp
 */

export { createHandlers, type HandlerConfig, type Handlers } from "./handlers";
export type { MCPToolDefinition } from "./tools";
export { tools } from "./tools";
