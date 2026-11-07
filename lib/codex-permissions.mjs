import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function desktopPermissionSelection(home = process.env.CODEX_HOME || path.join(homedir(), '.codex')) {
  try {
    const state = JSON.parse(readFileSync(path.join(home, '.codex-global-state.json'), 'utf8'));
    return state['electron-persisted-atom-state']?.['permission-selection-by-host-id:local'] || null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Codex 客户端权限设置无法读取：' + error.message);
  }
}

export function resolveCodexPermissions(config = {}, selection = null) {
  const sandbox = config.sandbox_mode || 'workspace-write';
  const desktopMode = selection?.kind === 'agent-mode' ? selection.agentMode : null;
  const reviewer = desktopMode === 'guardian-approvals' ? 'auto_review' : config.approvals_reviewer || 'user';
  const approvalPolicy = config.approval_policy || 'on-request';
  const workspace = config.sandbox_workspace_write || {};
  const networkAccess = workspace.network_access === true;
  if (!['workspace-write', 'read-only', 'danger-full-access'].includes(sandbox)) throw new Error('Codex 返回了无法识别的权限配置。');
  const sandboxPolicy = sandbox === 'danger-full-access' ? {type:'dangerFullAccess'} : sandbox === 'read-only' ? { type: 'readOnly', networkAccess } : {
    type: 'workspaceWrite', writableRoots: workspace.writable_roots || [], networkAccess,
    excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var === true,
    excludeSlashTmp: workspace.exclude_slash_tmp === true,
  };
  return { sandbox, sandboxPolicy, approvalPolicy, approvalsReviewer: reviewer };
}
