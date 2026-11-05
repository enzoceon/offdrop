import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { createClientOnlyFn } from "@tanstack/react-start";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";


const themeInitScript = `
(() => {
  try {
    const stored = localStorage.getItem("offdrop-theme") || localStorage.getItem("theme");
    const dark = stored ? stored === "dark" : true;
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (_) {}
})();`;

const registerPwaOnClient = createClientOnlyFn(async () => {
  const { registerAppServiceWorker } = await import("../lib/pwa.client");
  await registerAppServiceWorker();
});

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
      },
      { name: "theme-color", content: "#08111f" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "msapplication-TileColor", content: "#08111f" },
      { name: "format-detection", content: "telephone=no" },
      { name: "application-name", content: "OFFDROP" },
      { property: "og:site_name", content: "OFFDROP" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { title: "OFFDROP — Offline File Transfer App" },
      { property: "og:title", content: "OFFDROP — Offline File Transfer App" },
      { name: "twitter:title", content: "OFFDROP — Offline File Transfer App" },
      {
        name: "description",
        content:
          "OFFDROP shares photos, videos, audio, and files offline with animated QR transfer streams.",
      },
      {
        property: "og:description",
        content:
          "Share photos, videos, audio, and files offline with animated QR transfer streams.",
      },
      {
        name: "twitter:description",
        content:
          "Share photos, videos, audio, and files offline with animated QR transfer streams.",
      },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/5deb9b38-7eb8-451b-a2c5-b1b5a113b32f/id-preview-ccd62582--c4d46c8c-76c3-48d9-8c3c-9ca2c0b5b1f0.lovable.app-1781891913071.png",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/5deb9b38-7eb8-451b-a2c5-b1b5a113b32f/id-preview-ccd62582--c4d46c8c-76c3-48d9-8c3c-9ca2c0b5b1f0.lovable.app-1781891913071.png",
      },
      { name: "description", content: "OFFDROP converts images and videos into shareable QR codes, enabling offline content sharing across devices." },
      { property: "og:description", content: "OFFDROP converts images and videos into shareable QR codes, enabling offline content sharing across devices." },
      { name: "twitter:description", content: "OFFDROP converts images and videos into shareable QR codes, enabling offline content sharing across devices." },
      { property: "og:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/0271ed1b-9f1a-4de1-bfa3-eddd769f6c78" },
      { name: "twitter:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/attachments/og-images/0271ed1b-9f1a-4de1-bfa3-eddd769f6c78" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=Space+Grotesk:wght@600;700&display=swap",
      },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { rel: "icon", href: "/icon-16.png", sizes: "16x16", type: "image/png" },
      { rel: "apple-touch-icon", href: "/icon-180.png", sizes: "180x180" },
      { rel: "mask-icon", href: "/mask-icon.svg", color: "#64f0b4" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebApplication",
          name: "OFFDROP",
          url: "https://offdrop.app/",
          applicationCategory: "UtilitiesApplication",
          operatingSystem: "Any",
          description:
            "Offline QR file transfer for photos, videos, audio, and files across devices.",
        }),
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  useEffect(() => {
    void registerPwaOnClient();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
    </QueryClientProvider>
  );
}
