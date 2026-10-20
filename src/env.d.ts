/// <reference types="astro/client" />

interface Window {
  showPageAlert?: (opts: { type: string; title: string; message: string }) => void;
}
