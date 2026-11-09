// Installable-app setup: makes Creador de clips con IA behave like a phone app once
// the user adds it to their home screen — its own icon, full-screen
// standalone window, violet theme color, and a web app manifest built
// from the bundled app icons. Runs once at startup; every step is
// best-effort so a browser that ignores one of them just keeps the
// normal web experience.

import icon192 from "./assets/app-icon-192.png";
import icon512 from "./assets/app-icon-512.png";

export function setupInstallableApp(): void {
  try {
    const head = document.head;

    const ensureMeta = (name: string, content: string) => {
      if (head.querySelector(`meta[name="${name}"]`)) return;
      const meta = document.createElement("meta");
      meta.name = name;
      meta.content = content;
      head.appendChild(meta);
    };
    ensureMeta("theme-color", "#7c3aed");
    ensureMeta("mobile-web-app-capable", "yes");
    ensureMeta("apple-mobile-web-app-capable", "yes");
    ensureMeta("apple-mobile-web-app-status-bar-style", "default");
    ensureMeta("apple-mobile-web-app-title", "Clips con IA");

    // iOS home-screen icon.
    if (!head.querySelector('link[rel="apple-touch-icon"]')) {
      const touch = document.createElement("link");
      touch.rel = "apple-touch-icon";
      touch.href = new URL(icon192, document.baseURI).href;
      head.appendChild(touch);
    }

    // Web app manifest, generated from the app's own bundled icons so
    // the home-screen install gets the real name, colors and artwork.
    if (!head.querySelector('link[rel="manifest"]')) {
      const startUrl = new URL(".", document.baseURI).href;
      const manifest = {
        name: "Creador de clips con IA",
        short_name: "Creador de clips con IA",
        description:
          "Saca los mejores clips de un video de YouTube y descárgalos en vertical 9:16 con subtítulos quemados, listos para TikTok.",
        id: startUrl,
        start_url: startUrl,
        scope: startUrl,
        display: "standalone",
        orientation: "portrait",
        background_color: "#efe9fb",
        theme_color: "#7c3aed",
        icons: [
          {
            src: new URL(icon192, document.baseURI).href,
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: new URL(icon512, document.baseURI).href,
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
        ],
      };
      const blob = new Blob([JSON.stringify(manifest)], {
        type: "application/manifest+json",
      });
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = URL.createObjectURL(blob);
      head.appendChild(link);
    }
  } catch {
    // Installability is an enhancement; never break the app over it.
  }
}
