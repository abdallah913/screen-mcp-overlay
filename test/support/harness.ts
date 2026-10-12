/**
 * The real MCP server, bundled for Node with Electron stubbed out and the UI
 * Automation helper replaced by canned responses (see useHelperTransport). Lets
 * the tests call every tool through the same code path an agent does.
 */
export { buildServer, stripSchemaNoise } from '../../src/main/mcp/server.js';
export { TOOL_NAMES } from '../../src/main/mcp/tools/index.js';
export { store } from '../../src/main/store.js';
export { setHudWindowRef, useHelperTransport } from '../../src/main/uia.js';
export { beginStep, answerStep, addClick, cancelStep, currentStep } from '../../src/main/steps.js';
export { answerText } from '../../src/main/mcp/tools/answers.js';
export {
    askToShare,
    isShared,
    resetSharing,
    shareApp,
    shareWindow,
    sharingSummary,
    stopSharingEverything,
    stopSharingWindow,
    wasRevoked,
    revocationCount
} from '../../src/main/sharing.js';
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
