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
//      右上角原生窗口按钮浮动区宽度由 overlayControlsWidth() 提供（CSS 变量），
//      供拖动条与需要右移的页面元素共用同一个值。

/** 右上角原生窗口按钮浮动区宽度（px）：优先用 WCO 实测，不支持时回退经验值。 */
function overlayControlsWidth() {
  try {
    const wco = navigator.windowControlsOverlay;
    if (wco && wco.visible && typeof wco.getTitlebarAreaRect === 'function') {
      const rect = wco.getTitlebarAreaRect();
      const width = Math.round(window.innerWidth - rect.x - rect.width);
      if (width > 60 && width < 400) return width;
    }
  } catch {
    /* 不支持 WCO：用回退值 */
  }
  return 138;
}

function installDragBar() {
  if (document.getElementById('dsh-desktop-dragbar')) return;

  // 先写变量，CSS 里的 var() 才有正确取值（取不到时用 138px 兜底）
  const applyOverlayWidth = () => {
    document.documentElement.style.setProperty('--dsh-overlay-width', `${overlayControlsWidth()}px`);
  };
  applyOverlayWidth();
  window.addEventListener('resize', applyOverlayWidth);

  const style = document.createElement('style');
  style.textContent = [
    '#dsh-desktop-dragbar {',
    '  position: fixed;',
    '  top: 0;',
    '  left: 0;',
    // 右侧让出原生系统按钮浮动区（titleBarOverlay，Win11 约 138px 宽）
    '  width: calc(100% - var(--dsh-overlay-width, 138px));',
    '  height: 28px;',
    '  -webkit-app-region: drag;',
    '  z-index: 2147483646;',
    '  pointer-events: auto;',
    '}',
    // 隐藏会话 header 的 utilities 容器（导出 log 按钮区），布局其余不动
    '[class$="_headerUtilities"] { display: none !important; }',
    // 插件管理页：右上角「刷新 / 安装插件」按钮默认在页头 28px 处，会落进原生
    // 窗口按钮浮动区（约 138×40，贴窗口右上角）被遮住：整体下移让开即可，
    // 右对齐保持上游原样。最小让开量 = 浮动区高 40 - 页头 padding-top 28 = 12px，
    // 取 16px 留点间隙。
    'section[data-plugin-panel] > header [class$="_toolbar"] {',
    '  margin-top: 16px;',
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
