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
import type { AppWarning } from "../api/types";
import { WarningToasts, type WarningToastsLabels } from "./WarningToasts";

/**
 * Vue-to-React adapter for the app warning stack. Warning state and dismiss
 * events remain owned by App.vue; React owns the visible stack and timers.
 */
export const ReactWarningToastsHost = defineComponent({
  name: "ReactWarningToastsHost",
  props: {
    warnings: {
      type: Array as PropType<AppWarning[]>,
      default: () => [],
    },
  },
  emits: ["dismiss"],
  setup(props, { emit }) {
    const hostRef = ref<HTMLElement | null>(null);
    let reactRoot: Root | null = null;

    function labels(): WarningToastsLabels {
      const t = i18n.global.t;
      return {
        dismiss: String(t("warnings.dismiss")),
        errorLabel: String(t("warnings.errorLabel")),
        diagnostics: String(t("warnings.diagnostics")),
        hideDetails: String(t("warnings.hideDetails")),
        showDetails: String(t("warnings.showDetails")),
        copyDetails: String(t("warnings.copyDetails")),
        copied: String(t("warnings.copied")),
      };
    }

    function renderReact(): void {
      if (reactRoot === null) return;
      reactRoot.render(
        createElement(WarningToasts, {
          warnings: props.warnings,
          labels: labels(),
          onDismiss: (index: number) => emit("dismiss", index),
        }),
      );
    }

    watch([() => props.warnings, () => i18n.global.locale.value], renderReact, {
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

    return () => h("div", { ref: hostRef, class: "react-warning-toasts-host" });
  },
});
