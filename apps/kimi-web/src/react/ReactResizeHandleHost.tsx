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
import { ResizeHandle } from "./ResizeHandle";

/**
 * Vue-to-React adapter for the resizable separator. App.vue continues to own
 * the sidebar/detail-panel widths and transition state; React owns the visible
 * handle, persisted width, and pointer lifecycle until the shell migrates.
 */
export const ReactResizeHandleHost = defineComponent({
  name: "ReactResizeHandleHost",
  inheritAttrs: false,
  props: {
    storageKey: {
      type: String,
      required: true,
    },
    defaultWidth: {
      type: Number,
      required: true,
    },
    min: {
      type: Number,
      required: true,
    },
    max: {
      type: Number,
      required: true,
    },
    reverse: {
      type: Boolean,
      default: false,
    },
    ariaLabel: {
      type: String as PropType<string | undefined>,
      default: undefined,
    },
  },
  emits: ["update:width", "update:dragging"],
  setup(props, { emit, attrs }) {
    const hostRef = ref<HTMLElement | null>(null);
    let reactRoot: Root | null = null;

    function renderReact(): void {
      if (reactRoot === null) return;
      const t = i18n.global.t;
      reactRoot.render(
        createElement(ResizeHandle, {
          storageKey: props.storageKey,
          defaultWidth: props.defaultWidth,
          min: props.min,
          max: props.max,
          reverse: props.reverse,
          ariaLabel: props.ariaLabel ?? String(t("layout.resizeHandleAria")),
          onWidthChange: (width: number) => emit("update:width", width),
          onDraggingChange: (dragging: boolean) =>
            emit("update:dragging", dragging),
        }),
      );
    }

    watch(
      [
        () => props.storageKey,
        () => props.defaultWidth,
        () => props.min,
        () => props.max,
        () => props.reverse,
        () => props.ariaLabel,
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

    return () =>
      h("div", {
        ...attrs,
        ref: hostRef,
        class: ["react-resize-handle-host", attrs.class],
      });
  },
});
