function isPreviewHost(hostname: string) {
  return (
    hostname.startsWith("id-preview--") ||
    hostname.startsWith("preview--") ||
    hostname === "lovableproject.com" ||
    hostname.endsWith(".lovableproject.com") ||
    hostname === "lovableproject-dev.com" ||
    hostname.endsWith(".lovableproject-dev.com") ||
    hostname === "beta.lovable.dev" ||
    hostname.endsWith(".beta.lovable.dev")
  );
}

function shouldRefuseServiceWorker() {
  if (!import.meta.env.PROD) return true;
  if (window.self !== window.top) return true;
  if (isPreviewHost(window.location.hostname)) return true;
  if (new URL(window.location.href).searchParams.get("sw") === "off") return true;
  return false;
}

async function unregisterAppServiceWorkers() {
  if (!("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.allSettled(
    registrations
      .filter((registration) => {
        const worker = registration.active || registration.waiting || registration.installing;
        return worker?.scriptURL ? new URL(worker.scriptURL).pathname === "/sw.js" : false;
      })
      .map((registration) => registration.unregister()),
  );
}

export async function registerAppServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (shouldRefuseServiceWorker()) {
    await unregisterAppServiceWorkers();
    return;
  }

  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
}