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

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');

// dsh 的 ESM 入口，作为依赖安装（files 含 lib/*.js，无 exports 限制）
const DSH_BIN = require.resolve('@deepseek-ai/dsh/lib/bin.js');

// dsh web 启动完成后打印的一行：`dsh web: http://127.0.0.1:3080 (LAN: ...)`
const URL_LINE_RE = /dsh web:\s*(https?:\/\/\S+)/;

let mainWindow = null;
let dshProcess = null;
let dshUrl = null;
let stopping = false;

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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
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

  // 窗口标题由本应用掌控：阻止页面 <title> 覆盖，并按启动状态显示
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(state.status === 'ready' ? 'DeepSeek Harness' : '正在启动 DeepSeek Harness…');
  });

  // 先展示本地 loading 页，dsh URL 就绪后再切过去
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
}

app.whenReady().then(() => {
  // 移除默认菜单栏（Windows/Linux）；macOS 保留以维持复制粘贴等系统快捷键
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  ipcMain.handle('dsh:state', () => ({ ...state }));
  createWindow();
  startDsh();

  // macOS 惯例：Dock 点击时若无窗口则重建（这里重建即重启服务）
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      stopping = false;
      dshUrl = null;
      createWindow();
      startDsh();
    }
  });
});

// 所有窗口关闭 → 停服务并退出（dsh 是本地服务，关窗后无存在意义）
app.on('window-all-closed', () => {
  stopDsh();
  app.quit();
});

app.on('before-quit', () => {
  stopDsh();
});
