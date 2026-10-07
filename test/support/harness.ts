/**
 * The real MCP server, bundled for Node with Electron stubbed out and the UI
 * Automation helper replaced by canned responses (see useHelperTransport). Lets
 * the tests call every tool through the same code path an agent does.
 */
export { buildServer, stripSchemaNoise } from '../../src/main/mcp/server.js';
export { TOOL_NAMES } from '../../src/main/mcp/tools.js';
export { store } from '../../src/main/store.js';
export { useHelperTransport } from '../../src/main/uia.js';
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
