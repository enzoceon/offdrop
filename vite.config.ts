// Standard TanStack Start + Nitro setup (documented at tanstack.com/start → Hosting).
//
// Nitro supports multiple deployment presets: locally and on standard hosts `vite build`
// produces a standalone server in .output/. Override with NITRO_PRESET=<preset> as needed
// (e.g. NITRO_PRESET=node-server, NITRO_PRESET=cloudflare-module, etc.).
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom", "@tanstack/react-router", "@tanstack/react-start"],
  },
  // The QR decode worker is an ES module worker (it imports jsQR).
  worker: { format: "es" },
  plugins: [
    tsConfigPaths(),
    tailwindcss(),
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    tanstackStart({ server: { entry: "server" } }),
    nitro(),
    viteReact(),
    VitePWA({
        strategies: "generateSW",
        filename: "sw.js",
        injectRegister: null,
        registerType: "autoUpdate",
        devOptions: { enabled: false },
        manifest: false,
        workbox: {
          navigateFallbackDenylist: [/^\/~oauth/, /^\/api\//],
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.mode === "navigate",
              handler: "NetworkFirst",
              options: {
                cacheName: "offdrop-pages",
                networkTimeoutSeconds: 3,
              },
            },
            {
              urlPattern: ({ url }) =>
                url.origin === self.location.origin && /\/assets\/.*-[\w-]+\.(js|css|woff2?)$/.test(url.pathname),
              handler: "CacheFirst",
              options: {
                cacheName: "offdrop-assets",
                expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
            {
              urlPattern: ({ url }) =>
                url.origin === self.location.origin && /\/(icon-\d+\.png|favicon\.svg|manifest\.webmanifest|zxing_reader\.wasm)$/.test(url.pathname),
              handler: "CacheFirst",
              options: {
                cacheName: "offdrop-static",
                expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
  ],
});
