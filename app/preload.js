const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kc', {
  call: async (ch, arg) => {
    const r = await ipcRenderer.invoke(ch, arg);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on: (ch, cb) => ipcRenderer.on(ch, (e, d) => cb(d)),
});
