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

// 设置窗口 API：插件管理 + 其他设置（loading/主页面不使用，无副作用）
contextBridge.exposeInMainWorld('settingsAPI', {
  getInfo: () => ipcRenderer.invoke('settings:get-info'),
  installPlugin: (name) => ipcRenderer.invoke('settings:install-plugin', name),
  removePlugin: (name) => ipcRenderer.invoke('settings:remove-plugin', name),
  restartDsh: () => ipcRenderer.invoke('settings:restart-dsh'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('settings:set-auto-launch', enabled),
  openDataDir: () => ipcRenderer.invoke('settings:open-data-dir'),
  checkUpdate: () => ipcRenderer.invoke('settings:check-update'),
  openExternal: (url) => ipcRenderer.invoke('settings:open-external', url),
  getPluginsDir: () => ipcRenderer.invoke('settings:get-plugins-dir'),
  setPluginsDir: () => ipcRenderer.invoke('settings:set-plugins-dir'),
  onTheme: (cb) => {
    const listener = (_event, payload) => cb(payload.theme);
    ipcRenderer.on('settings:theme', listener);
    return () => ipcRenderer.removeListener('settings:theme', listener);
  },
  onPluginOutput: (cb) => {
    const listener = (_event, line) => cb(line);
    ipcRenderer.on('settings:plugin-output', listener);
    return () => ipcRenderer.removeListener('settings:plugin-output', listener);
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

// ---- 标题栏可拖动：Windows/Linux 隐藏原生标题栏后页面顶部不可拖动窗口，
//      注入一条 -webkit-app-region: drag 的条；右侧让出原生系统按钮区 ----
//      高度锁定 28px（用户指定），不随页面内容变化。
function installDragBar() {
  if (document.getElementById('dsh-desktop-dragbar')) return;

  const style = document.createElement('style');
  style.textContent = [
    '#dsh-desktop-dragbar {',
    '  position: fixed;',
    '  top: 0;',
    '  left: 0;',
    // 右侧让出原生系统按钮浮动区（titleBarOverlay，Win11 约 138px 宽）
    '  width: calc(100% - 138px);',
    '  height: 28px;',
    '  -webkit-app-region: drag;',
    '  z-index: 2147483646;',
    '  pointer-events: auto;',
    '}',
    // 隐藏会话 header 的 utilities 容器（导出 log 按钮区），布局其余不动
    '[class$="_headerUtilities"] { display: none !important; }',
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
