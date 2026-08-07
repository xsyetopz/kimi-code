import type { PluginSummary } from "@moonshot-ai/kimi-code-sdk";

import {
  buildPluginsInfoLines,
  buildPluginsListLines,
} from "../components/messages/plugins-status-panel";
import { UsagePanelComponent } from "../components/messages/usage-panel";
import type { SlashCommandHost } from "./dispatch";
import { resolvePluginApi } from "./plugins-api";

export async function renderPluginsList(
  host: SlashCommandHost,
  plugins?: readonly PluginSummary[],
): Promise<void> {
  const currentPlugins =
    plugins ?? (await (await resolvePluginApi(host)).listPlugins());
  const title = ` Plugins (${currentPlugins.length}) `;
  const panel = new UsagePanelComponent(
    () => buildPluginsListLines({ plugins: currentPlugins }),
    "primary",
    title,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

export async function renderPluginInfo(
  host: SlashCommandHost,
  id: string,
): Promise<void> {
  const info = await (await resolvePluginApi(host)).getPluginInfo(id);
  const panel = new UsagePanelComponent(
    () => buildPluginsInfoLines({ info }),
    "primary",
    ` ${info.id} `,
  );
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

export async function reloadPlugins(host: SlashCommandHost): Promise<void> {
  const summary = await (await resolvePluginApi(host)).reloadPlugins();
  const line =
    `Reload: +${summary.added.length} -${summary.removed.length}` +
    (summary.errors.length > 0 ? ` (${summary.errors.length} errors)` : "");
  host.showStatus(line);
  // Rebuild the TUI's plugin slash-command list from the reloaded service so
  // newly added/enabled commands resolve in this session-less UI right away.
  await host.refreshPluginCommands(host.session);
}
