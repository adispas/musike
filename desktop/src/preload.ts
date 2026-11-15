import { contextBridge, ipcRenderer } from "electron";

/** ipcRenderer.invoke wraps errors as "Error invoking remote method '…': Error: <message>": keep the message. */
const invoke = async (channel: string, ...args: unknown[]) => {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (e) {
    throw new Error(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  }
};

// The only bridge between the web app and the desktop shell.
contextBridge.exposeInMainWorld("musikeDesktop", {
  platform: process.platform,
  setTheme: (theme: "dark" | "light") => ipcRenderer.send("musike:theme", theme),
  setLanguage: (lang: string) => ipcRenderer.send("musike:lang", lang),
  retry: () => ipcRenderer.send("musike:retry"),
  // Google Cast (src/cast): the web app's side is web/src/cast/electron.ts.
  cast: {
    startDiscovery: () => ipcRenderer.send("musike:cast", "startDiscovery"),
    stopDiscovery: () => ipcRenderer.send("musike:cast", "stopDiscovery"),
    connect: (id: string) => invoke("musike:cast-connect", id),
    disconnect: () => invoke("musike:cast-disconnect"),
    load: (media: unknown) => invoke("musike:cast-load", media),
    command: (name: string, value?: number | boolean) => invoke("musike:cast-command", name, value),
    onEvent: (fn: (event: string, payload: unknown) => void) => {
      ipcRenderer.on("musike:cast-event", (_e, event: string, payload: unknown) => fn(event, payload));
    },
  },
});
