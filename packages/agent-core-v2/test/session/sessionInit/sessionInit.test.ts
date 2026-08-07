import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncDescriptor } from "#/_base/di/descriptors";
import { DisposableStore } from "#/_base/di/lifecycle";
import { TestInstantiationService } from "#/_base/di/test";
import { UserCancellationError } from "#/_base/utils/abort";
import { IBootstrapService } from "#/app/bootstrap/bootstrap";
import { IEventBus } from "#/app/event/eventBus";
import { IHostEnvironment } from "#/os/interface/hostEnvironment";
import {
  IHostFileSystem,
  type HostFileStat,
} from "#/os/interface/hostFileSystem";
import { IAgentPermissionModeService } from "#/agent/permissionMode/permissionMode";
import { IAgentProfileService } from "#/agent/profile/profile";
import { IAgentAgentsMdReminderService } from "#/agent/agentsMdReminder/agentsMdReminder";
import { IAgentSystemReminderService } from "#/agent/systemReminder/systemReminder";
import { IWireService } from "#/wire/wire";
import { ErrorCodes, Error2 } from "#/errors";
import { IAgentLifecycleService } from "#/session/agentLifecycle/agentLifecycle";
import { ISessionContext } from "#/session/sessionContext/sessionContext";
import { ISessionInitService } from "#/session/sessionInit/sessionInit";
import { SessionInitService } from "#/session/sessionInit/sessionInitService";
