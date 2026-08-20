'use strict';

/**
 * DSH Desktop 主进程：壳 + 本地服务方案。
 *
 * 思路：
 *  - 用 ELECTRON_RUN_AS_NODE=1 把 Electron 二进制当作纯 Node 运行时，
 *    以子进程拉起 dsh 的 ESM 入口（@deepseek-ai/dsh/lib/bin.js web --port 0），
 *    不依赖系统安装的 node/npx，也保持自包含。
 *  - dsh 打印 `dsh web: http://127.0.0.1:<port>` 后，主进程解析出 URL，
 *    让 BrowserWindow 从本地 loading 页切换到该地址。
 *  - 窗口关闭即停掉 dsh 进程树（Windows 用 taskkill /T /F，POSIX 用 SIGTERM→SIGKILL）。
 */

const { app, BrowserWindow, ipcMain, Menu, nativeTheme, Tray, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// dsh 的 ESM 入口，作为依赖安装（files 含 lib/*.js，无 exports 限制）
const DSH_BIN = require.resolve('@deepseek-ai/dsh/lib/bin.js');

// dsh web 启动完成后打印的一行：`dsh web: http://127.0.0.1:3080 (LAN: ...)`
const URL_LINE_RE = /dsh web:\s*(https?:\/\/\S+)/;

// 项目信息：设置窗口“关于”面板与更新检查使用
const REPO = 'Minomiao/deepseek-harness-desktop';
const REPO_URL = `https://github.com/${REPO}`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

let mainWindow = null;
let dshProcess = null;
let dshUrl = null;
let stopping = false;

// 托盘：关闭窗口时最小化到系统托盘，dsh 本地服务继续运行
let tray = null;
let trayEnabled = false;
let isQuitting = false;

// 设置窗口（托盘菜单「设置」打开）：插件管理 + 其他设置
let settingsWindow = null;

// 当前界面主题（light | dark），跟随 dsh 主题，用于设置窗口配色
let uiTheme = 'light';

// 内置的独立 pnpm 二进制（@pnpm/exe），加进 PATH 让 `dsh plugin` 无需用户安装 node/pnpm
const PNPM_DIR = path.dirname(require.resolve('@pnpm/exe/package.json'));

const state = {
  status: 'starting', // starting | ready | error
  url: null,
  error: null,
};

function updateState(patch) {
  Object.assign(state, patch);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:state', { ...state });
  }
}

// ---- 主题同步：读取 dsh 持久化的主题偏好（~/.dsh/settings.yaml 的 ui-theme.preference），
//      把 Electron 原生主题（标题栏/菜单栏）对齐到它。
//      关键：preference 为 "system" 时必须保持 nativeTheme.themeSource = 'system'，
//      否则会反过来影响页面内 prefers-color-scheme，锁死 dsh 的"跟随系统"。 ----
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const THEME_LOG = path.join(DSH_HOME, 'dsh-desktop-theme.log');

function logTheme(msg) {
  try {
    fs.appendFileSync(THEME_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* 忽略日志写入失败 */
  }
}

function readThemePreference() {
  try {
    const text = fs.readFileSync(path.join(DSH_HOME, 'settings.yaml'), 'utf8');
    // 提取 ui-theme 块（其后所有缩进行），再取 preference 值
    const block = /^\s*ui-theme:\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m.exec(text);
    if (block) {
      const pref = /^\s+preference:\s*['"]?(\w+)['"]?\s*(?:\r?\n|$)/m.exec(block[1]);
      if (pref) return pref[1];
    }
  } catch {
    /* 文件不存在或读取失败：按 system 处理 */
  }
  return 'system';
}

// 标题栏覆盖层颜色：跟随 dsh 页面背景色。
//  浅色页面背景：--dsw-static-neutral-bluish-00 = rgb(255,255,255)（纯白）
//  深色页面背景：--dsw-static-neutral-bluish-950 = rgb(21,21,23) = #151517
const THEME_COLORS = {
  light: { overlay: '#ffffff', symbol: '#000000', bg: '#ffffff' },
  dark: { overlay: '#151517', symbol: '#ffffff', bg: '#151517' },
};

function currentThemeColors() {
  return nativeTheme.shouldUseDarkColors ? THEME_COLORS.dark : THEME_COLORS.light;
}

function syncTitleBarOverlay() {
  // setTitleBarOverlay 仅 Windows/Linux 支持；macOS 交通灯颜色由系统自适应，无需处理
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { overlay, symbol } = currentThemeColors();
  try {
    mainWindow.setTitleBarOverlay({ color: overlay, symbolColor: symbol });
    logTheme(`titleBarOverlay -> ${overlay} / ${symbol}`);
  } catch (err) {
    logTheme(`titleBarOverlay failed: ${err.message}`);
  }
}

function applyThemeFromPreference() {
  const preference = readThemePreference();
  const source = preference === 'dark' || preference === 'light' ? preference : 'system';
  nativeTheme.themeSource = source;
  uiTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  logTheme(`applyThemeFromPreference -> preference=${preference}, themeSource=${source}, uiTheme=${uiTheme}, shouldUseDarkColors=${nativeTheme.shouldUseDarkColors}`);
  // 让标题栏覆盖层颜色跟随页面背景色
  syncTitleBarOverlay();
  // 让设置窗口配色跟随主题
  syncSettingsTheme();
}

/** 把当前主题推给设置窗口（配色/窗口底色）。 */
function syncSettingsTheme() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.setBackgroundColor(uiTheme === 'dark' ? '#151517' : '#ffffff');
    settingsWindow.webContents.send('settings:theme', { theme: uiTheme });
  }
}

/** 停掉 dsh 进程树；幂等。 */
function stopDsh() {
  const proc = dshProcess;
  if (!proc || stopping) return;
  stopping = true;
  dshProcess = null;

  if (process.platform === 'win32') {
    // Windows 无信号机制：强制结束整棵进程树（含 spawn 出的 pwsh/bash 子进程）
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
  } else {
    proc.kill('SIGTERM'); // dsh 有 SIGTERM 优雅关停处理
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.once('exit', () => clearTimeout(timer));
  }
}

/** 启动 dsh web 子进程。 */
function startDsh() {
  updateState({ status: 'starting', url: null, error: null });

  const child = spawn(process.execPath, [DSH_BIN, 'web', '--port', '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  dshProcess = child;

  let stderrTail = '';
  const onData = (buf) => {
    const text = buf.toString();
    const match = URL_LINE_RE.exec(text);
    if (match && !dshUrl) {
      dshUrl = match[1];
      updateState({ status: 'ready', url: dshUrl });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(dshUrl).catch((err) => {
          updateState({ status: 'error', error: `窗口加载 ${dshUrl} 失败: ${err.message}` });
        });
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', (buf) => {
    stderrTail = (stderrTail + buf.toString()).slice(-4000);
  });

  child.on('error', (err) => {
    updateState({ status: 'error', error: `dsh 启动失败: ${err.message}` });
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    updateState({
      status: 'error',
      error: dshUrl
        ? `dsh 进程意外退出 (code=${code}, signal=${signal})`
        : `dsh 进程退出 (code=${code}, signal=${signal})${stderrTail ? `\n${stderrTail}` : ''}`,
    });
  });
}

function createWindow() {
  // 此时 applyThemeFromPreference() 已设置 nativeTheme，据此选窗口底色与标题栏颜色
  const { overlay, symbol, bg } = currentThemeColors();
  // Windows/Linux：隐藏原生标题栏，用覆盖层绘制与页面同色的标题栏条（保留系统窗口按钮）。
  // Linux 上仅在桌面环境支持客户端装饰（CSD，如 GNOME 默认）时生效，其余 WM 会退回系统标题栏。
  const useOverlay = process.platform === 'win32' || process.platform === 'linux';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: bg,
    autoHideMenuBar: true,
    // 隐藏原生标题栏，用覆盖层绘制与页面同色的标题栏条（保留系统窗口按钮）
    ...(useOverlay
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: overlay, symbolColor: symbol, height: 40 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 关闭按钮 → 最小化到系统托盘（托盘不可用时保持原“关窗即退出”行为）
  mainWindow.on('close', (event) => {
    if (!isQuitting && trayEnabled) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // 窗口标题由本应用掌控：阻止页面 <title> 覆盖，并按启动状态显示
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(state.status === 'ready' ? 'DeepSeek Harness' : '正在启动 DeepSeek Harness…');
  });

  // 先展示本地 loading 页，dsh URL 就绪后再切过去
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
}

/** 显示并聚焦主窗口（托盘点击 / 菜单唤起）。 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 创建系统托盘：点击显示窗口，菜单提供“显示主窗口 / 退出”。 */
function createTray() {
  try {
    const iconPath =
      process.platform === 'win32'
        ? path.join(__dirname, '..', 'build', 'icon.ico')
        : path.join(__dirname, '..', 'build', 'icon.png');
    tray = new Tray(iconPath);
    tray.setToolTip('DSH Desktop');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: showMainWindow },
        { type: 'separator' },
        { label: '设置', click: createSettingsWindow },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ])
    );
    // Windows/Linux：左键单击托盘图标直接显示窗口；macOS 点击默认弹出菜单
    if (process.platform !== 'darwin') tray.on('click', showMainWindow);
    trayEnabled = true;
  } catch (err) {
    // 个别 Linux 桌面无托盘支持：退回普通“关窗即退出”行为
    logTheme(`tray creation failed: ${err.message}`);
  }
}

/** 简单语义化版本比较：a < b 返回 -1，a == b 返回 0，a > b 返回 1。 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 800,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    resizable: true,
    title: 'DSH Desktop 设置',
    autoHideMenuBar: true,
    backgroundColor: uiTheme === 'dark' ? '#151517' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/**
 * 运行 `dsh plugin --profile web <args...>`（转发给内置 pnpm），
 * 输出实时转发给设置窗口，返回退出码。
 */
function runPluginCommand(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DSH_BIN, 'plugin', '--profile', 'web', ...args], {
      cwd: DSH_HOME,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PATH: PNPM_DIR + path.delimiter + (process.env.PATH || ''),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const emit = (text) => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('settings:plugin-output', text);
      }
    };
    child.stdout.on('data', (buf) => emit(buf.toString()));
    child.stderr.on('data', (buf) => emit(buf.toString()));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// 单实例锁：只允许一个实例运行。第二个实例（双击 exe / 再次启动）直接退出，
// 并通知第一个实例聚焦主窗口，避免多开（多份 dsh 服务 + 多托盘图标 + 争抢 ~/.dsh）。
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    // 移除默认菜单栏（Windows/Linux）；macOS 保留以维持复制粘贴等系统快捷键
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

    ipcMain.handle('dsh:state', () => ({ ...state }));

    // ---- 设置窗口 IPC：插件管理 + 其他设置 ----

    // 汇总信息：数据目录、版本、已安装插件（bundles）、开机自启状态
    ipcMain.handle('settings:get-info', () => {
      const profilePkg = path.join(DSH_HOME, 'profiles', 'web', 'package.json');
      let bundles = [];
      let dependencies = [];
      try {
        const manifest = JSON.parse(fs.readFileSync(profilePkg, 'utf8'));
        bundles = manifest.dsh?.profile?.bundles ?? [];
        dependencies = Object.keys(manifest.dependencies ?? {});
      } catch {
        /* web profile 尚未初始化 */
      }
      let autoLaunch = false;
      try {
        autoLaunch = app.getLoginItemSettings().openAtLogin;
      } catch {
        /* 部分平台不支持 */
      }
      let dshVersion = '';
      try {
        const dshPkg = JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(require.resolve('@deepseek-ai/dsh/lib/bin.js')), '..', 'package.json'),
            'utf8'
          )
        );
        dshVersion = dshPkg.version || '';
      } catch {
        /* 忽略 */
      }
      return {
        dshHome: DSH_HOME,
        version: app.getVersion(),
        dshVersion,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node,
        bundles,
        dependencies,
        autoLaunch,
        theme: uiTheme,
        repo: REPO_URL,
      };
    });

    // 检查 GitHub 最新 Release 并对比本地版本（GitHub 公开 API，无需鉴权）
    ipcMain.handle('settings:check-update', async () => {
      try {
        const res = await fetch(LATEST_RELEASE_API, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': REPO },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
        const rel = await res.json();
        const latest = String(rel.tag_name || '').replace(/^v/, '');
        const current = app.getVersion();
        return {
          ok: true,
          hasUpdate: compareVersions(latest, current) > 0,
          latest,
          current,
          url: rel.html_url || `${REPO_URL}/releases`,
          notes: rel.body || '',
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('settings:open-external', (_event, url) => {
      if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
      return { ok: true };
    });

    ipcMain.handle('settings:install-plugin', async (_event, name) => {
      if (!name || !/^[\w@./~-]+$/.test(name)) return { ok: false, message: '包名格式不正确' };
      const code = await runPluginCommand(['add', name]);
      return {
        ok: code === 0,
        message: code === 0 ? '安装成功，重启服务后生效' : `安装失败（退出码 ${code}）`,
      };
    });

    ipcMain.handle('settings:remove-plugin', async (_event, name) => {
      if (!name || !/^[\w@./~-]+$/.test(name)) return { ok: false, message: '包名格式不正确' };
      const code = await runPluginCommand(['remove', name]);
      return { ok: code === 0, message: code === 0 ? '卸载成功' : `卸载失败（退出码 ${code}）` };
    });

    // 重启 dsh 服务，让新装插件生效
    ipcMain.handle('settings:restart-dsh', () => {
      stopDsh();
      setTimeout(() => {
        stopping = false;
        dshUrl = null;
        startDsh();
      }, 600);
      return { ok: true };
    });

    ipcMain.handle('settings:set-auto-launch', (_event, enabled) => {
      app.setLoginItemSettings({ openAtLogin: !!enabled });
      return { ok: true };
    });

    ipcMain.handle('settings:open-data-dir', () => {
      shell.openPath(DSH_HOME);
      return { ok: true };
    });

    // 页面上报了主题变化（<html style="color-scheme"> / <body data-ds-dark-theme> 变动）
    // 重新读取持久化偏好并对齐原生主题
    ipcMain.on('dsh:theme', () => {
      logTheme('IPC dsh:theme received');
      applyThemeFromPreference();
    });

    // 兜底：settings.yaml 本身被写入（UI 切换偏好）时也重新对齐，覆盖 DOM/IPC 的时序差
    const settingsFile = path.join(DSH_HOME, 'settings.yaml');
    fs.watchFile(settingsFile, { interval: 500 }, () => {
      logTheme('settings.yaml changed');
      applyThemeFromPreference();
    });

    // “跟随系统”模式下，OS 主题变化（不改 dsh 设置）也同步标题栏覆盖层颜色
    nativeTheme.on('updated', () => {
      logTheme('nativeTheme updated');
      applyThemeFromPreference();
    });

    // 启动时即按持久化偏好设置原生主题，避免白屏/标题栏闪色
    applyThemeFromPreference();
    createTray();
    createWindow();
    startDsh();

    // macOS 惯例：Dock 点击时恢复/重建窗口
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        stopping = false;
        dshUrl = null;
        createWindow();
        startDsh();
      } else {
        showMainWindow();
      }
    });
  });

  // 托盘启用时，窗口关闭只是隐藏，应用与 dsh 服务继续在后台运行；
  // 真正退出走托盘菜单“退出”（before-quit 里停服务）
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopDsh();
  });
}
