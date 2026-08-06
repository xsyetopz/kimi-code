import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { defineComponent, h, onBeforeUnmount, onMounted, type PropType, ref, watch } from "vue";

import i18n from "../i18n";
import { GlobalLoading, type GlobalLoadingLabels } from "./GlobalLoading";

/**
 * Minimal Vue-to-React adapter for the first-load splash. Vue still controls
 * when the splash mounts; React owns the complete visible surface.
 */
export const ReactGlobalLoadingHost = defineComponent({
  name: "ReactGlobalLoadingHost",
  props: {
    issue: {
      type: String as PropType<string | null>,
      default: null,
    },
  },
  setup(props) {
    const hostRef = ref<HTMLElement | null>(null);
    let reactRoot: Root | null = null;

    function labels(): GlobalLoadingLabels {
      const t = i18n.global.t;
      return {
        connecting: String(t("app.connecting")),
        connectRetrying: String(t("app.connectRetrying")),
      };
    }

    function renderReact(): void {
      if (reactRoot === null) return;
      reactRoot.render(
        createElement(GlobalLoading, {
          issue: props.issue,
          labels: labels(),
        }),
      );
    }

    watch([() => props.issue, () => i18n.global.locale.value], renderReact);

    onMounted(() => {
      if (hostRef.value === null) return;
      reactRoot = createRoot(hostRef.value);
      renderReact();
    });

    onBeforeUnmount(() => {
      reactRoot?.unmount();
      reactRoot = null;
    });

    return () => h("div", { ref: hostRef, class: "react-global-loading-host" });
  },
});

