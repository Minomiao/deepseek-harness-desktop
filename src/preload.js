'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 向 loading 页暴露最小只读 API：查询/订阅 dsh 启动状态
contextBridge.exposeInMainWorld('dshDesktop', {
  getState: () => ipcRenderer.invoke('dsh:state'),
  onState: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('dsh:state', listener);
    return () => ipcRenderer.removeListener('dsh:state', listener);
  },
});
