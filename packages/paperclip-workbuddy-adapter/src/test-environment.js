import { randomUUID } from 'node:crypto';
import { runChildProcess } from '@paperclipai/adapter-utils/server-utils';
import { assertLocal, resolveConfig } from './config.js';
import { createRedactor } from './redact.js';

/** @param {import('@paperclipai/adapter-utils').AdapterEnvironmentTestContext} ctx */
export async function testEnvironment(ctx) {
  /** @type {import('@paperclipai/adapter-utils').AdapterEnvironmentCheck[]} */
  const checks = [];
  try {
    assertLocal(ctx.executionTarget);
    const config = resolveConfig(ctx.config);
    const proc = await runChildProcess(`workbuddy-probe-${randomUUID()}`, config.command, [...config.prefixArgs, '--help'], {
      cwd: config.cwd, env: { ...config.env, CODEBUDDY_CONFIG_DIR: config.configDir }, timeoutSec: 45, graceSec: 2, onLog: async () => {},
    });
    if (proc.exitCode !== 0 || proc.timedOut) throw new Error('WorkBuddy help probe did not finish successfully.');
    for (const flag of ['--print', '--input-format', '--output-format', '--resume', '--permission-mode']) if (!proc.stdout.includes(flag)) throw new Error(`WorkBuddy CLI does not advertise ${flag}.`);
    checks.push({ code: 'workbuddy_cli', level: 'info', message: 'WorkBuddy supports the required streaming and resume flags.' });
    checks.push({ code: 'workbuddy_auth_unverified', level: 'warn', message: 'Authentication and model access have not been tested.', hint: 'Run npm run smoke -- --config <local-config.json> to make a small real request.' });
  } catch (error) {
    const redact = createRedactor(Object.values(ctx.config.env || {}).filter((/** @type {unknown} */ v) => typeof v === 'string'));
    checks.push({ code: 'workbuddy_environment', level: 'error', message: redact(error instanceof Error ? error.message : String(error)) });
  }
  return { adapterType: 'workbuddy_local', status: /** @type {'fail' | 'warn'} */ (checks.some(c => c.level === 'error') ? 'fail' : 'warn'), checks, testedAt: new Date().toISOString() };
}
