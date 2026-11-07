import { execute } from './execute.js';
import { sessionCodec } from './session.js';
import { testEnvironment } from './test-environment.js';

export const type = 'workbuddy_local';
export const label = 'WorkBuddy (local CLI)';
/** @type {import('@paperclipai/adapter-utils').AdapterModel[]} */
export const models = [];
export const agentConfigurationDoc = `# WorkBuddy local CLI
Runs WorkBuddy's installed CLI on the Paperclip host. Configure an absolute cwd and
either cliPath (the bundled JavaScript entry) or command (a native executable).
configDir defaults to ~/.workbuddy. Login through WorkBuddy before running tasks.
The default dontAsk permission mode denies unapproved tools; it does not bypass permissions.
Remote targets, desktop bridges, and automatic replay are not supported in this prototype.
Use promptTemplate or Paperclip task context. An instructionsFilePath can supply the Paperclip skill.
`;

/** @returns {import('@paperclipai/adapter-utils').ServerAdapterModule} */
export function createServerAdapter() {
  return {
    type, execute, testEnvironment, sessionCodec, models, agentConfigurationDoc,
    supportsLocalAgentJwt: true, runtimeToolDelivery: 'environment',
    supportsInstructionsBundle: true, instructionsPathKey: 'instructionsFilePath',
    requiresMaterializedRuntimeSkills: true,
    getConfigSchema: () => ({ fields: [
      { key: 'cwd', label: 'Working directory', type: 'text', required: true },
      { key: 'cliPath', label: 'WorkBuddy JavaScript CLI entry', type: 'text' },
      { key: 'command', label: 'Native command (instead of cliPath)', type: 'text', hint: 'An executable or PATH command; shell scripts are not supported.' },
      { key: 'configDir', label: 'WorkBuddy configuration directory', type: 'text', hint: 'Default: ~/.workbuddy. Uses your existing WorkBuddy login.' },
      { key: 'model', label: 'Model', type: 'text', hint: 'Leave empty to use the configured model.' },
      { key: 'effort', label: 'Reasoning effort', type: 'text' },
      { key: 'permissionMode', label: 'Permission mode', type: 'select', default: 'dontAsk', options: [{ label: 'Deny unapproved actions', value: 'dontAsk' }, { label: 'Client default (may need interaction)', value: 'default' }] },
      { key: 'timeoutSec', label: 'Timeout (seconds)', type: 'number', default: 7200 },
      { key: 'promptTemplate', label: 'Additional task prompt', type: 'textarea' },
    ] }),
  };
}
