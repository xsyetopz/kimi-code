import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  ref,
  type PropType,
  watch,
} from "vue";

import i18n from "../i18n";
import type { ThinkingLevel } from "../api/types";
import type { ConversationStatus } from "../types";
import { StatusPanel, type StatusPanelLabels } from "./StatusPanel";

/**
 * Vue-to-React adapter for the /status overlay. Session state and close
 * ownership stay in App.vue while React owns the complete visible dialog.
 */
export const ReactStatusPanelHost = defineComponent({
  name: "ReactStatusPanelHost",
  props: {
    status: {
      type: Object as PropType<ConversationStatus>,
      required: true,
    },
    thinking: {
      type: String as PropType<ThinkingLevel>,
      required: true,
    },
    planMode: {
      type: Boolean,
      required: true,
    },
    swarmMode: {
      type: Boolean,
      default: false,
    },
    costUsd: {
      type: Number as PropType<number | undefined>,
      default: undefined,
    },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const hostRef = ref<HTMLElement | null>(null);
    let reactRoot: Root | null = null;

    function labels(): StatusPanelLabels {
      const t = i18n.global.t;
      return {
        title: String(t("status.statusPanelTitle")),
        close: String(t("status.statusPanelClose")),
        model: String(t("status.statusModel")),
        thinking: String(t("status.statusThinking")),
        permission: String(t("status.statusPermission")),
        planMode: String(t("status.statusPlanMode")),
        swarmMode: String(t("status.statusSwarmMode")),
        context: String(t("status.statusContext")),
        cost: String(t("status.statusCost")),
        contextValue: (used, max, pct) =>
          String(t("status.statusContextValue", { used, max, pct })),
        none: String(t("status.statusNone")),
        permissionManual: String(t("status.permissionManual")),
        permissionAuto: String(t("status.permissionAuto")),
        permissionYolo: String(t("status.permissionYolo")),
        planOn: String(t("status.planOn")),
        planOff: String(t("status.planOff")),
        swarmOn: String(t("status.swarmOn")),
        swarmOff: String(t("status.swarmOff")),
      };
    }

    function renderReact(): void {
      if (reactRoot === null) return;
      reactRoot.render(
        createElement(StatusPanel, {
          status: props.status,
          thinking: props.thinking,
          planMode: props.planMode,
          swarmMode: props.swarmMode,
          costUsd: props.costUsd,
          labels: labels(),
          onClose: () => emit("close"),
        }),
      );
    }

    watch(
      [
        () => props.status,
        () => props.thinking,
        () => props.planMode,
        () => props.swarmMode,
        () => props.costUsd,
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

    return () => h("div", { ref: hostRef, class: "react-status-panel-host" });
  },
});
