import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexPermissions } from '../lib/codex-permissions.mjs';
const config = {sandbox_mode:'workspace-write',sandbox_workspace_write:{network_access:true,writable_roots:['E:/shared'],exclude_slash_tmp:true}};
test('desktop automatic review and project network settings are inherited without forcing manual review',()=>{
  const p=resolveCodexPermissions(config,{kind:'agent-mode',agentMode:'guardian-approvals'});
  assert.equal(p.approvalsReviewer,'auto_review');assert.equal(p.approvalPolicy,'on-request');assert.equal(p.sandboxPolicy.networkAccess,true);
  assert.deepEqual(p.sandboxPolicy.writableRoots,['E:/shared']);assert.equal(p.sandboxPolicy.excludeSlashTmp,true);
});
test('native read-only and no-network configuration remain effective',()=>{
  const p=resolveCodexPermissions({sandbox_mode:'read-only',approval_policy:'never',sandbox_workspace_write:{network_access:false}},null);
  assert.equal(p.approvalsReviewer,'user');assert.equal(p.sandboxPolicy.type,'readOnly');assert.equal(p.sandboxPolicy.networkAccess,false);
});
test('configured reviewer is retained without desktop selection and unattended denial stays restrictive',()=>{
  assert.equal(resolveCodexPermissions({...config,approvals_reviewer:'auto_review'}).approvalsReviewer,'auto_review');
  assert.equal(resolveCodexPermissions({...config,approval_policy:'never'}).approvalPolicy,'never');
  assert.equal(resolveCodexPermissions({sandbox_mode:'danger-full-access'}).sandboxPolicy.type,'dangerFullAccess');
});
