import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import vue from "@vitejs/plugin-vue";
import Icons from "unplugin-icons/vite";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const webPort = Number(process.env.WEB_PORT) || 5175;
// The Vite dev proxy has one configured kap-server target. Override it with
// KIMI_SERVER_URL when debugging a non-default local instance.
const serverTarget = process.env.KIMI_SERVER_URL || "http://127.0.0.1:58627";
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as {
  version: string;
};

// Shared proxy behavior for dev AND preview. It strips the browser `Origin`
// header on the forwarded request. The proxy rewrites `Host` to the server
// (`changeOrigin`) but leaves `Origin` pointing at the Vite origin, and
// kap-server's WS upgrade path rejects that mismatch with 403. An Origin-less
// request is treated as a non-browser client (the browser talks only to its
// own origin, so it never needs CORS).
const apiProxyOptions = {
  target: serverTarget,
  changeOrigin: true,
  ws: true,
  configure: (proxy: {
    on(
      event: string,
      listener: (proxyReq: { removeHeader(name: string): void }) => void,
    ): unknown;
  }) => {
    proxy.on("proxyReq", (proxyReq) => proxyReq.removeHeader("origin"));
    proxy.on("proxyReqWs", (proxyReq) => proxyReq.removeHeader("origin"));
  },
};

export default defineConfig({
  plugins: [
    react(),
    vue(),
    Icons({
      compiler: "vue3",
      // Local Kimi Design System icons (24×24 outlined, fill="currentColor"),
      // copied from the design-system icon pack into src/icons/kimi/ and
      // imported as `~icons/kimi/<file-name>` (plus `?raw`), same as the ri
      // collection. Registered in src/lib/icons.ts only.
      customCollections: {
        kimi: FileSystemIconLoader(
          fileURLToPath(new URL("./src/icons/kimi", import.meta.url)),
        ),
      },
    }),
  ],
  define: {
    __KIMI_DEV_PROXY_TARGET__: JSON.stringify(serverTarget),
    __KIMI_WEB_VERSION__: JSON.stringify(pkg.version),
    // True only for the web bundle embedded in the Kimi Desktop app (set by the
    // desktop-build workflow). Gates an "internal testing build" banner. When
    // false (default) the banner is tree-shaken out of the production bundle.
    __KIMI_WEB_DESKTOP__: JSON.stringify(process.env.KIMI_WEB_DESKTOP === "1"),
  },
  server: {
    port: webPort,
    strictPort: false,
    // Same-origin dev: the browser calls Vite, Vite forwards to the server.
    // No CORS anywhere. The real server serves REST + WS all under /api/v1.
    proxy: {
      "/api/v1": apiProxyOptions,
    },
  },
  // `vite preview` (the production build served locally) needs the same proxy —
  // bugs that only exist in production chunking (e.g. optional-peer-dep stubs)
  // can't be reproduced without running the built app against a server.
  // Preview intentionally stays on the static target: no runtime switcher.
  preview: {
    port: Number(process.env.WEB_PREVIEW_PORT) || 4175,
    proxy: {
      "/api/v1": apiProxyOptions,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  // Workers that import modules with code-splitting (e.g. mermaid's dynamic
  // diagram imports) need ES format — IIFE cannot split chunks. The app
  // already targets ES2022 so all supported browsers handle module workers.
  worker: {
    format: "es",
  },
});
