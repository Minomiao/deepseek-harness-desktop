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

// ---- 标题栏可拖动：WCO 覆盖层区域默认不可拖动窗口，
//      需按规范在页面顶部注入一条 -webkit-app-region: drag 的条 ----
//      Chromium 的 no-drag 只对 drag 元素的【后代】生效，兄弟覆盖层无法
//      挖孔，因此覆盖式拖动条必然盖住其下的按钮。方案：动态压低拖动条
//      高度——只占条带内小型按钮（如侧边栏收展按钮）顶部以上的区域，
//      按钮整体留在拖动条下方、完全可点击；拖拽区在每个状态自动取最大。
function installDragBar() {
  if (document.getElementById('dsh-desktop-dragbar')) return;

  const style = document.createElement('style');
  style.textContent = [
    '#dsh-desktop-dragbar {',
    '  position: fixed;',
    '  top: 0;',
    '  left: 0;',
    '  width: env(titlebar-area-width, 100%);',
    '  height: env(titlebar-area-height, 40px);',
    '  -webkit-app-region: drag;',
    '  z-index: 2147483646;',
    '  pointer-events: auto;',
    '}',
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'dsh-desktop-dragbar';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);

  const STRIP_HEIGHT = 40; // 与 titlebar-area-height 一致
  let fitTimer = null;

  // 找到条带内最靠上的“小型”交互元素，拖动条高度取到它顶部为止。
  function fitHeight() {
    if (!bar.isConnected) return;
    let minTop = STRIP_HEIGHT;
    const candidates = document.querySelectorAll(
      'button, a, [role="button"], input, textarea, select, [contenteditable="true"], [tabindex]'
    );
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      // 只在顶部条带内、且是小型图标按钮（收展按钮 28~36px）
      if (rect.bottom <= 0 || rect.top >= STRIP_HEIGHT) continue;
      if (rect.width > 64 || rect.height > 64) continue;
      minTop = Math.min(minTop, rect.top);
    }
    bar.style.height = `${Math.max(8, Math.round(minTop))}px`;
  }

  function scheduleFit() {
    if (fitTimer) return;
    fitTimer = setTimeout(() => {
      fitTimer = null;
      fitHeight();
    }, 200);
  }

  fitHeight();
  window.addEventListener('resize', scheduleFit);
  new MutationObserver(scheduleFit).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
  });
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
