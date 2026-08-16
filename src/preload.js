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

// ---- 主题同步：把页面深/浅色信号转发给主进程，让原生标题栏跟随 ----
// dsh 前端通过 <html style="color-scheme"> 与 <body data-ds-dark-theme> 标记主题
function readDark() {
  const root = document.documentElement;
  if (root && root.style.colorScheme) return root.style.colorScheme === 'dark';
  if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return true;
  return false;
}

function reportTheme() {
  ipcRenderer.send('dsh:theme', readDark() ? 'dark' : 'light');
}

function startThemeSync() {
  const target = document.documentElement;
  if (!target) return;

  // 立即上报一次，避免切换前就启动导致标题栏与页面不一致
  reportTheme();

  const observer = new MutationObserver(reportTheme);
  observer.observe(target, { attributes: true, attributeFilter: ['style'] });
  if (document.body) {
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
  }
}

// ---- 标题栏可拖动：WCO 覆盖层区域默认不可拖动窗口，
//      需按规范在页面顶部注入一条 -webkit-app-region: drag 的条 ----
function installDragBar() {
  if (document.getElementById('dsh-desktop-dragbar')) return;

  const style = document.createElement('style');
  style.textContent = [
    '#dsh-desktop-dragbar {',
    '  position: fixed;',
    '  top: 0;',
    '  left: env(titlebar-area-x, 0px);',
    '  width: env(titlebar-area-width, 100%);',
    '  height: env(titlebar-area-height, 40px);',
    '  -webkit-app-region: drag;',
    '  z-index: 2147483647;',
    '}',
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'dsh-desktop-dragbar';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);
}

function startUiHelpers() {
  // Windows/Linux 使用覆盖层标题栏，需要注入拖动区域；macOS 保留原生标题栏（原生即可拖动）
  if (process.platform === 'win32' || process.platform === 'linux') installDragBar();
  startThemeSync();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startUiHelpers, { once: true });
} else {
  startUiHelpers();
}
