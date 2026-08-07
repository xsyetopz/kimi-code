import type {
  CapabilityStatus,
  PluginInfo,
  PluginSummary,
} from "@moonshot-ai/kimi-code-sdk";

import {
  PluginMcpSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsPanelComponent,
  type PluginMcpSelection,
  type PluginRemoveConfirmResult,
  type PluginsPanelSelection,
} from "../components/dialogs/plugins-selector";
import { formatErrorMessage } from "../utils/event-payload";
import { isOfficialPluginSource } from "../utils/plugin-source-label";
import { KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV } from "#/constant/app";
import {
  loadPluginMarketplace,
  type PluginMarketplaceEntry,
} from "#/utils/plugin-marketplace";
import { openUrl } from "#/utils/open-url";
import type { SlashCommandHost } from "./dispatch";
import {
  pluginInlineChangeHint,
  resolvePluginApi,
  type ShowPluginMcpPickerOptions,
  type ShowPluginsPickerOptions,
} from "./plugins-api";
import {
  installCapabilityFromPanel,
  installFromPanel,
  isCapabilityEntry,
  removePlugin,
} from "./plugins-install";
import { reloadPlugins, renderPluginInfo } from "./plugins-display";

/**
 * Adapt a capability from the engine's registry into a catalog row. The
 * engine is the single source of truth for what the built-in capabilities
 * are — the CLI only renders them. The `capability:<id>` source marker
 * routes installs through the capability flow (never a plain plugin
 * install), so the row needs no real URL.
 */
function capabilityMarketplaceEntry(
  capability: CapabilityStatus,
): PluginMarketplaceEntry {
  return {
    id: capability.id,
    displayName: capability.displayName,
    description: capability.description,
    tier: "official",
    source: `capability:${capability.id}`,
    builtIn: true,
  };
}

async function loadMarketplaceCatalog(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  source: string | undefined,
  capabilities: readonly CapabilityStatus[],
): Promise<void> {
  try {
    // Injection is part of the DEFAULT catalog experience only: any explicit
    // replacement (the slash-command source or the env override) opts out
    // wholesale — its same-id rows are never masked and its failures surface.
    const isDefaultCatalog =
      source === undefined &&
      process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV] === undefined;
    const marketplace = await loadPluginMarketplace({
      workDir: host.state.appState.workDir,
      source,
      builtInEntries:
        host.engineV2 && isDefaultCatalog
          ? capabilities.map(capabilityMarketplaceEntry)
          : undefined,
    });
    panel.setMarketplace(marketplace.plugins, marketplace.source);
  } catch (error) {
    panel.setMarketplaceError(formatErrorMessage(error));
  }
  host.state.ui.requestRender();
}

export async function showPluginsPicker(
  host: SlashCommandHost,
  options?: ShowPluginsPickerOptions,
): Promise<void> {
  let plugins: readonly PluginSummary[];
  try {
    plugins = await (await resolvePluginApi(host)).listPlugins();
  } catch (error) {
    host.showError(`Failed to load plugins: ${formatErrorMessage(error)}`);
    return;
  }

  let capabilities: readonly CapabilityStatus[] = [];
  if (host.engineV2) {
    try {
      capabilities = await host.requireSession().listCapabilities();
    } catch (error) {
      host.showStatus(
        `Capability status unavailable: ${formatErrorMessage(error)}. Plugin management remains available.`,
        "warning",
      );
    }
  }

  const panel = new PluginsPanelComponent({
    installed: plugins,
    installedIds: new Set(plugins.map((plugin) => plugin.id)),
    capabilities,
    catalogIsDefault:
      options?.marketplaceSource === undefined &&
      process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV] === undefined,
    initialTab: options?.initialTab,
    selectedId: options?.selectedId,
    pluginHint: options?.pluginHint,
    onSelect: (selection) => {
      // Each branch of the handler either mounts the next view or restores the
      // editor itself, so do not pre-restore here — that would flash the editor
      // for in-place actions like toggling a plugin.
      void handlePluginsPanelSelection(host, panel, selection).catch(
        (error: unknown) => {
          host.showError(`/plugins failed: ${formatErrorMessage(error)}`);
        },
      );
    },
    onCancel: () => {
      host.restoreEditor();
    },
    // Every tab except Custom needs the catalog: Official/Third-party list it,
    // and Installed uses it to show update badges. The Installed/Custom tabs
    // keep working even when the marketplace is unreachable (badges simply stay
    // hidden until data arrives).
    onRequestMarketplace: () => {
      void loadMarketplaceCatalog(
        host,
        panel,
        options?.marketplaceSource,
        capabilities,
      );
    },
  });
  host.mountEditorReplacement(panel);
  // Kick off the catalog fetch for any tab that needs it: Installed uses it for
  // update badges, Official/Third-party list it. Custom never reads the catalog,
  // so skip the fetch there. Done here (after `panel` is initialized) rather
  // than inside the component constructor, because the callback above closes
  // over `panel`.
  if (options?.initialTab !== "custom") {
    panel.setMarketplaceLoading();
    void loadMarketplaceCatalog(
      host,
      panel,
      options?.marketplaceSource,
      capabilities,
    );
  }
}

async function showPluginMcpPicker(
  host: SlashCommandHost,
  id: string,
  options?: ShowPluginMcpPickerOptions,
): Promise<void> {
  let info: PluginInfo;
  try {
    info = await (await resolvePluginApi(host)).getPluginInfo(id);
  } catch (error) {
    host.showError(
      `Failed to load plugin MCP servers: ${formatErrorMessage(error)}`,
    );
    return;
  }

  host.mountEditorReplacement(
    new PluginMcpSelectorComponent({
      info,
      selectedServer: options?.selectedServer,
      serverHint: options?.serverHint,
      onSelect: (selection) => {
        // Every MCP action re-mounts a picker, so let the handler do the
        // mounting — pre-restoring the editor here would flash on toggle.
        void handlePluginMcpSelection(host, selection).catch(
          (error: unknown) => {
            host.showError(`/plugins mcp failed: ${formatErrorMessage(error)}`);
          },
        );
      },
      onCancel: () => {
        host.restoreEditor();
        void showPluginsPicker(host, { selectedId: id });
      },
    }),
  );
}

export async function confirmRemovePlugin(
  host: SlashCommandHost,
  id: string,
): Promise<boolean> {
  let displayName = id;
  try {
    displayName = (await (await resolvePluginApi(host)).getPluginInfo(id))
      .displayName;
  } catch {
    // Keep the confirmation available even when plugin details cannot be loaded.
  }

  return new Promise((resolveConfirmed) => {
    host.mountEditorReplacement(
      new PluginRemoveConfirmComponent({
        id,
        displayName,
        onDone: (result: PluginRemoveConfirmResult) => {
          host.restoreEditor();
          resolveConfirmed(result.kind === "confirm");
        },
      }),
    );
  });
}

export async function applyPluginEnabled(
  host: SlashCommandHost,
  id: string,
  enabled: boolean,
  showStatus = true,
): Promise<string> {
  const session = await resolvePluginApi(host);
  await session.setPluginEnabled(id, enabled);
  let info: PluginInfo | undefined;
  try {
    info = await session.getPluginInfo(id);
  } catch {
    info = undefined;
  }
  const mcpHint =
    enabled &&
    info !== undefined &&
    info.mcpServerCount > info.enabledMcpServerCount
      ? ` Some MCP servers are disabled; re-enable with /plugins mcp enable ${id} <server>.`
      : "";
  if (showStatus) {
    host.showStatus(
      `${enabled ? "Enabled" : "Disabled"} ${id}. Run /reload or /new to apply.${mcpHint}`,
    );
  }
  const inlineMcpHint = mcpHint.length > 0 ? " · MCP servers disabled" : "";
  return `${pluginInlineChangeHint()}${inlineMcpHint}`;
}

async function handlePluginsPanelSelection(
  host: SlashCommandHost,
  panel: PluginsPanelComponent,
  selection: PluginsPanelSelection,
): Promise<void> {
  switch (selection.kind) {
    case "toggle": {
      const hint = await applyPluginEnabled(
        host,
        selection.id,
        selection.enabled,
        false,
      );
      await showPluginsPicker(host, {
        initialTab: "installed",
        selectedId: selection.id,
        pluginHint: { id: selection.id, text: hint },
      });
      return;
    }
    case "remove":
      if (!(await confirmRemovePlugin(host, selection.id))) {
        host.showStatus(`Remove cancelled: ${selection.id}.`);
        await showPluginsPicker(host, {
          initialTab: "installed",
          selectedId: selection.id,
        });
        return;
      }
      await removePlugin(host, selection.id);
      await showPluginsPicker(host, { initialTab: "installed" });
      return;
    case "mcp":
      await showPluginMcpPicker(host, selection.id);
      return;
    case "details":
      host.restoreEditor();
      await renderPluginInfo(host, selection.id);
      return;
    case "reload":
      await reloadPlugins(host);
      await showPluginsPicker(host, { initialTab: "installed" });
      return;
    case "install":
      if (isCapabilityEntry(host, selection.entry)) {
        await installCapabilityFromPanel(host, panel, selection.entry);
        return;
      }
      await installFromPanel(
        host,
        panel,
        selection.entry.source,
        selection.entry.displayName,
        isOfficialPluginSource(selection.entry.source),
      );
      return;
    case "install-source":
      await installFromPanel(
        host,
        panel,
        selection.source,
        selection.source,
        isOfficialPluginSource(selection.source),
      );
      return;
    case "open-url":
      host.restoreEditor();
      openUrl(selection.url);
      host.showStatus(
        `Opening the ${selection.label} page in your browser…`,
        "success",
      );
      host.showStatus(`If it did not open, visit ${selection.url}`);
      return;
  }
}

async function handlePluginMcpSelection(
  host: SlashCommandHost,
  selection: PluginMcpSelection,
): Promise<void> {
  switch (selection.kind) {
    case "toggle":
      await (await resolvePluginApi(host)).setPluginMcpServerEnabled(
        selection.pluginId,
        selection.server,
        selection.enabled,
      );
      await showPluginMcpPicker(host, selection.pluginId, {
        selectedServer: selection.server,
        serverHint: {
          server: selection.server,
          text: pluginInlineChangeHint(),
        },
      });
      return;
    case "back":
      await showPluginsPicker(host, { selectedId: selection.pluginId });
      return;
  }
}
