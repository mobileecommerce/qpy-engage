"use client";

import { useEffect } from "react";

/**
 * Registers the service worker.
 *
 * Deliberately not registered in development: a cached shell during local work means edits appear
 * to have no effect, which costs more time than the offline support saves.
 */
export default function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const host = location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return;
    // Registration failing is not worth surfacing — the app works without it, and a visible error
    // for a missing offline cache would only alarm people.
    navigator.serviceWorker.register("/sw.js").catch(() => null);
  }, []);
  return null;
}
