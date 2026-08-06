import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  type PropType,
  ref,
  watch,
} from "vue";

import i18n from "../i18n";
import { ThinkingPanel, type ThinkingPanelLabels } from "./ThinkingPanel";

/**
 * Vue-to-React adapter for the shared thinking/summary detail panel. App.vue
 * keeps the panel target and close handlers until the surrounding shell moves;
 * React owns the complete visible panel once this host is mounted.
 */
export const ReactThinkingPanelHost = defineComponent({
  name: "ReactThinkingPanelHost",
  props: {
    text: {
      type: String,
      required: true,
    },
    subtitle: {
      type: String as PropType<string | undefined>,
      default: undefined,
    },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const hostRef = ref<HTMLElement | null>(null);
    let reactRoot: Root | null = null;

    function labels(): ThinkingPanelLabels {
      const t = i18n.global.t;
      return {
        preview: String(t("common.preview")),
        panelTitle: String(t("thinking.panelTitle")),
        close: String(t("thinking.close")),
      };
    }

    function renderReact(): void {
      if (reactRoot === null) return;
      reactRoot.render(
        createElement(ThinkingPanel, {
          text: props.text,
          subtitle: props.subtitle,
          labels: labels(),
          onClose: () => emit("close"),
        }),
      );
    }

    watch(
      [
        () => props.text,
        () => props.subtitle,
        () => i18n.global.locale.value,
      ],
      renderReact,
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

    return () => h("div", { ref: hostRef, class: "react-thinking-panel-host" });
  },
});
