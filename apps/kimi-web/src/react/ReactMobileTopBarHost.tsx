import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineComponent, h, onBeforeUnmount, onMounted, type PropType, ref, watch } from "vue";

import i18n from "../i18n";
import type { WorkspaceView } from "../types";
import { MobileTopBar, type MobileTopBarLabels } from "./MobileTopBar";

/**
 * Vue-to-React strangler adapter for the mobile title bar. The adapter is
 * intentionally limited to prop forwarding and event translation so state
 * and sheet ownership stay in App.vue until that shell migrates.
 */
export const ReactMobileTopBarHost = defineComponent({
  name: "ReactMobileTopBarHost",
  props: {
    workspace: {
      type: Object as PropType<WorkspaceView | null>,
      default: null,
    },
    sessionTitle: {
      type: String,
      default: "",
    },
    running: {
      type: Boolean,
      default: false,
    },
    branch: {
      type: String,
      default: "",
    },
    sessionCount: {
      type: Number,
      default: 0,
    },
  },
  emits: ["openSwitcher", "openSettings"],
  setup(props, { emit }) {
    const hostRef = ref<HTMLElement | null>(null);
    let reactRoot: Root | null = null;

    function labels(): MobileTopBarLabels {
      const t = i18n.global.t;
      return {
        openSwitcher: String(t("mobile.openSwitcher")),
        openSettings: String(t("mobile.openSettings")),
        noWorkspace: String(t("workspace.noWorkspace")),
        running: String(t("mobile.running")),
        idle: String(t("mobile.idle")),
        sessionCount: String(t("mobile.sessionCount", { n: props.sessionCount })),
      };
    }

    function renderReact(): void {
      if (reactRoot === null) return;
      reactRoot.render(
        createElement(MobileTopBar, {
          workspace: props.workspace,
          sessionTitle: props.sessionTitle,
          running: props.running,
          branch: props.branch,
          sessionCount: props.sessionCount,
          labels: labels(),
          onOpenSwitcher: () => emit("openSwitcher"),
          onOpenSettings: () => emit("openSettings"),
        }),
      );
    }

    watch(
      [
        () => props.workspace,
        () => props.sessionTitle,
        () => props.running,
        () => props.branch,
        () => props.sessionCount,
        () => i18n.global.locale.value,
      ],
      renderReact,
      { deep: true },
    );

    onMounted(() => {
      if (hostRef.value === null) return;
      reactRoot = createRoot(hostRef.value);
      renderReact();
    });

    onBeforeUnmount(() => {
      reactRoot?.unmount();
      reactRoot = null;
    });

    return () => h("div", { ref: hostRef, class: "react-mobile-topbar-host" });
  },
});
