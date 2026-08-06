import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type VNode,
} from "vue";

import { Banner, type BannerVariant } from "./Banner";

/**
 * Vue-to-React adapter for the Banner primitive. Vue retains slot/state
 * ownership during the strangler migration; textual default-slot content is
 * forwarded to React while the complete visible banner remains React-owned.
 */
export const ReactBannerHost = defineComponent({
  name: "ReactBannerHost",
  props: {
    variant: {
      type: String as () => BannerVariant,
      default: "info",
    },
  },
  setup(props, { slots }) {
    const hostRef = ref<HTMLElement | null>(null);
    let reactRoot: Root | null = null;

    function textFromVNode(value: unknown): string {
      if (typeof value === "string" || typeof value === "number") {
        return String(value);
      }
      if (Array.isArray(value)) return value.map(textFromVNode).join("");
      if (value && typeof value === "object" && "children" in value) {
        return textFromVNode((value as VNode).children);
      }
      return "";
    }

    function slotText(): string {
      return textFromVNode(slots.default?.() ?? []);
    }

    function renderReact(): void {
      if (reactRoot === null) return;
      reactRoot.render(
        createElement(Banner, {
          variant: props.variant,
          children: slotText(),
        }),
      );
    }

    watch([() => props.variant, () => slots.default?.()], renderReact, {
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

    return () => h("div", { ref: hostRef, class: "react-banner-host" });
  },
});
