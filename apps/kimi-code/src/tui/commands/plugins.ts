import { formatErrorMessage } from "../utils/event-payload";
import { isOfficialPluginSource } from "../utils/plugin-source-label";
import type { SlashCommandHost } from "./dispatch";
import { resolvePluginApi, truncateForStatus } from "./plugins-api";
import {
  confirmInstallTrust,
  installPluginFromSource,
  removePlugin,
} from "./plugins-install";
import {
  applyPluginEnabled,
  confirmRemovePlugin,
  showPluginsPicker,
} from "./plugins-picker";
import {
  renderPluginInfo,
  renderPluginsList,
  reloadPlugins,
} from "./plugins-display";

export { __pluginsCommandInternals } from "./plugins-install";

export async function handlePluginsCommand(
  host: SlashCommandHost,
  rawArgs: string,
): Promise<void> {
  const args = rawArgs
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const sub = args[0];
  const rest = args.slice(1);
  const session = await resolvePluginApi(host);

  try {
    if (sub === undefined) {
      await showPluginsPicker(host);
      return;
    }
    if (sub === "list") {
      await renderPluginsList(host);
      return;
    }
    if (sub === "install") {
      const source = rest.join(" ").trim();
      if (source.length === 0) {
        host.showError("Usage: /plugins install <local-path-or-zip-url>");
        return;
      }
      if (
        !(await confirmInstallTrust(
          host,
          source,
          isOfficialPluginSource(source),
        ))
      ) {
        host.showStatus("Install cancelled.");
        return;
      }
      const spinner = host.showProgressSpinner(
        `Installing plugin from ${truncateForStatus(source)}…`,
      );
      try {
        await installPluginFromSource(host, source);
        spinner.stop({
          ok: true,
          label: `Install finished — see details below.`,
        });
      } catch (error) {
        spinner.stop({
          ok: false,
          label: `Install failed: ${formatErrorMessage(error)}`,
        });
        throw error;
      }
      return;
    }
    if (sub === "marketplace") {
      const marketplaceSource = rest.join(" ").trim() || undefined;
      await showPluginsPicker(host, {
        // Custom marketplaces often omit `tier`, so their entries land on the
        // Third-party tab (entry.tier !== 'official'). Open there when a custom
        // source is supplied; otherwise the default catalog's official entries
        // make Official the right landing tab.
        initialTab:
          marketplaceSource === undefined ? "official" : "third-party",
        marketplaceSource,
      });
      return;
    }
    if (sub === "info") {
      const id = rest[0];
      if (id === undefined) {
        await showPluginsPicker(host);
        return;
      }
      await renderPluginInfo(host, id);
      return;
    }
    if (sub === "mcp") {
      const action = rest[0];
      const id = rest[1];
      const server = rest[2];
      if (
        (action !== "enable" && action !== "disable") ||
        id === undefined ||
        server === undefined
      ) {
        host.showError("Usage: /plugins mcp enable|disable <id> <server>");
        return;
      }
      await session.setPluginMcpServerEnabled(id, server, action === "enable");
      host.showStatus(
        `${action === "enable" ? "Enabled" : "Disabled"} MCP server ${server} for ${id}. Run /reload or /new to apply.`,
      );
      return;
    }
    if (sub === "enable" || sub === "disable") {
      const id = rest[0];
      if (id === undefined) {
        await showPluginsPicker(host);
        return;
      }
      await applyPluginEnabled(host, id, sub === "enable");
      return;
    }
    if (sub === "remove") {
      const id = rest[0];
      if (id === undefined) {
        host.showError("Usage: /plugins remove <id>");
        return;
      }
      if (!(await confirmRemovePlugin(host, id))) {
        host.showStatus(`Remove cancelled: ${id}.`);
        return;
      }
      await removePlugin(host, id);
      return;
    }
    if (sub === "reload") {
      await reloadPlugins(host);
      return;
    }
    const plugins = await session.listPlugins();
    if (plugins.some((plugin) => plugin.id === sub)) {
      await renderPluginInfo(host, sub);
      return;
    }
    host.showError(
      `Unknown /plugins action: ${sub}. Run /plugins to choose interactively.`,
    );
  } catch (error) {
    host.showError(
      `/plugins ${sub ?? ""} failed: ${formatErrorMessage(error)}`,
    );
  }
}
