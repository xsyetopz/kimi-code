import { useEffect, useRef } from "react";
import { createApp, type App as VueApp } from "vue";

import App from "../App.vue";
import i18n from "../i18n";

/**
 * Temporary strangler boundary for the existing Vue product tree.
 * React owns the browser root; Vue owns only this isolated DOM island until
 * each visible feature has a React replacement.
 */
export function LegacyVueIsland(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const vueApp: VueApp = createApp(App);
    vueApp.use(i18n);
    vueApp.mount(host);
    return () => {
      vueApp.unmount();
    };
  }, []);

  return <div ref={hostRef} data-kimi-vue-island="legacy-app" />;
}
