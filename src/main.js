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

const { app, BrowserWindow, ipcMain, Menu, nativeTheme, Tray } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// dsh 的 ESM 入口，作为依赖安装（files 含 lib/*.js，无 exports 限制）
const DSH_BIN = require.resolve('@deepseek-ai/dsh/lib/bin.js');

// dsh web 启动完成后打印的一行：`dsh web: http://127.0.0.1:3080 (LAN: ...)`
const URL_LINE_RE = /dsh web:\s*(https?:\/\/\S+)/;

let mainWindow = null;
let dshProcess = null;
let dshUrl = null;
let stopping = false;

// 托盘：关闭窗口时最小化到系统托盘，dsh 本地服务继续运行
let tray = null;
let trayEnabled = false;
let isQuitting = false;

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
  logTheme(`applyThemeFromPreference -> preference=${preference}, themeSource=${source}, shouldUseDarkColors=${nativeTheme.shouldUseDarkColors}`);
  // 让标题栏覆盖层颜色跟随页面背景色
  syncTitleBarOverlay();
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
