import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCall } from "#/kosong/contract/message";
import type { ToolInputDisplay } from "#/tool/toolInputDisplay";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DisposableStore } from "#/_base/di/lifecycle";
import { createServices, type TestInstantiationService } from "#/_base/di/test";
import {
  literalRulePattern,
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
} from "#/tool/rule-match";
import type { ResolvedToolExecutionHookContext } from "#/agent/toolExecutor/toolHooks";
import {
  IHostEnvironment,
  type IHostEnvironment as HostEnvironmentService,
} from "#/os/interface/hostEnvironment";
import { IAgentPermissionModeService } from "#/agent/permissionMode/permissionMode";
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyEvaluation,
} from "#/agent/permissionPolicy/permissionPolicy";
import type { PermissionMode } from "#/agent/permissionPolicy/types";
import { AgentPermissionPolicyService } from "#/agent/permissionPolicy/permissionPolicyService";
import {
  IAgentPermissionRulesService,
  type IAgentPermissionRulesService as PermissionRulesServiceContract,
  type PermissionRule,
} from "#/agent/permissionRules/permissionRules";
import {
  IAgentScopeContext,
  makeAgentScopeContext,
} from "#/agent/scopeContext/scopeContext";
import { IGitService } from "#/app/git/git";
import { findGitWorkTree } from "#/app/git/workTree";
import { HostFileSystem } from "#/os/backends/node-local/hostFsService";
import {
  ToolAccesses,
  type ToolAccesses as ToolAccessList,
} from "#/tool/toolContract";
import { ISessionWorkspaceContext } from "#/session/workspaceContext/workspaceContext";
import { IWorkspaceLeaseService } from "#/workspace/workspaceLease/workspaceLease";
import { WorkspaceLeaseService } from "#/workspace/workspaceLease/workspaceLeaseService";

