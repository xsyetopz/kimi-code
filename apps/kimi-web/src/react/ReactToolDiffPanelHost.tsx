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
import type { ToolDiffTarget } from "../types";
import { ToolDiffPanel, type ToolDiffPanelLabels } from "./ToolDiffPanel";

/**
 * Vue-to-React adapter for the right-side tool diff panel. Vue keeps ownership
 * of the detail-panel state until the shell migration; React owns the target's
 * visible rendering and translates the close event back to Vue.
 */
export const ReactToolDiffPanelHost = defineComponent({
  name: "ReactToolDiffPanelHost",
  props: {
    target: {
      type: Object as PropType<ToolDiffTarget>,
      required: true,
    },
  },
  emits: ["close"],
  setup(props, { emit }) {
    const hostRef = ref<HTMLElement | null>(null);
    let reactRoot: Root | null = null;

    function labels(): ToolDiffPanelLabels {
      const t = i18n.global.t;
      return {
        close: String(t("thinking.close")),
        noDiff: String(t("diff.noDiff")),
      };
    }

    function renderReact(): void {
      if (reactRoot === null) return;
      reactRoot.render(
        createElement(ToolDiffPanel, {
          target: props.target,
          labels: labels(),
          onClose: () => emit("close"),
        }),
      );
    }

    watch([() => props.target, () => i18n.global.locale.value], renderReact, {
      deep: true,
    });

    onMounted(() => {
      if (hostRef.value === null) return;
      reactRoot = createRoot(hostRef.value);
      renderReact();
    });

    onBeforeUnmount(() => {
      reactRoot?.unmount();
      reactRoot = null;
    });

    // Keep a real wrapper: .global-preview sizes its direct child during the
    // Vue-to-React transition, while the React panel fills that wrapper.
    return () => h("div", { ref: hostRef, class: "react-tool-diff-panel-host" });
  },
});

