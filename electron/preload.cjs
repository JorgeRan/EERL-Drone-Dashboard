const { contextBridge } = require('electron');

// Expose a minimal, explicit API surface for future secure IPC additions.
contextBridge.exposeInMainWorld('electronAPI', {});
