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

const { app, BrowserWindow, ipcMain, Menu, nativeTheme, Tray, shell, dialog, net } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { normalizePluginSpec, parseTarballSpec, tarballUrl, escapeRegExp, findBundlePackages, buildPackage } = require('./plugin-util');

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

/** 把 dsh/pnpm 输出流式转发给设置窗口。 */
function emitPluginOutput(text) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:plugin-output', text);
  }
}

/**
 * 运行 `dsh plugin --profile web <args...>`（转发给内置 pnpm）。
 * 收集完整输出用于失败分析（如 allowBuilds 拦截），同时实时推给设置窗口。
 * @returns {Promise<{code: number, output: string}>}
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
    let output = '';
    child.stdout.on('data', (buf) => {
      const text = buf.toString();
      output += text;
      emitPluginOutput(text);
    });
    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      output += text;
      emitPluginOutput(text);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * 安装插件后的启动探测：以 `dsh web --port 0` 真实拉起一次 web。
 * 出现 `dsh web: http://…` 视为成功；进程提前退出（如 CLI 参数冲突）视为失败。
 * 探测进程在结束前会被强制关闭（Windows 用 taskkill 清整棵进程树）。
 * @returns {Promise<{ok: boolean, reason: string, output: string}>}
 */
function verifyWebBoot(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DSH_BIN, 'web', '--port', '0'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      } else {
        child.kill('SIGTERM');
      }
      resolve({ ok, reason, output: output.slice(-1500) });
    };
    const timer = setTimeout(() => finish(true, '启动正常'), timeoutMs);
    const onData = (buf) => {
      const text = buf.toString();
      output += text;
      if (!settled && URL_LINE_RE.test(text)) finish(true, '启动正常');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      if (!settled) {
        finish(code === 0, code === 0 ? '进程退出' : `进程退出（code=${code}）`);
      }
    });
  });
}

/** 直接从 web profile 的 package.json 移除某插件（依赖 + bundle 列表），不经过 pnpm。 */
function removePluginFromManifest(name) {
  const p = path.join(DSH_HOME, 'profiles', 'web', 'package.json');
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete m.dependencies?.[name];
    if (m.dsh?.profile?.bundles) {
      m.dsh.profile.bundles = m.dsh.profile.bundles.filter((b) => b !== name);
    }
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  } catch {
    /* 文件不存在或无法解析：忽略，回滚已尽力 */
  }
}

// ---- 用户插件：输入规范化 / 免 git 下载 / 可选择的存放目录 / 构建脚本放行 ----

/** 桌面应用自身的设置（userData 下 JSON），与 dsh 的 settings.yaml 互不干扰。 */
function readDesktopSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'desktop-settings.json'), 'utf8'));
  } catch {
    return {};
  }
}
function writeDesktopSettings(patch) {
  const current = readDesktopSettings();
  Object.assign(current, patch);
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'desktop-settings.json'), JSON.stringify(current, null, 2));
  } catch {
    /* 忽略写入失败 */
  }
}
/** 用户插件源码的存放目录：默认 ~/.dsh/plugins，可在设置里改。 */
function getPluginsDir() {
  const dir = readDesktopSettings().pluginsDir;
  return typeof dir === 'string' && dir && fs.existsSync(dir) ? dir : path.join(DSH_HOME, 'plugins');
}

/** 检测系统是否装有 git（pnpm 的 git 依赖需要它）。 */
function isGitAvailable() {
  return new Promise((resolve) => {
    execFile('git', ['--version'], (err) => resolve(!err));
  });
}

/**
 * 由 github:/gitlab: spec 生成免 git 的 tarball 下载地址。
 * 未指定分支时查询仓库默认分支（GitHub / GitLab API，走系统代理），失败回退 main。
 */
async function resolveTarballUrl(spec) {
  const parsed = parseTarballSpec(spec);
  if (!parsed) return null;
  let branch = parsed.ref;
  if (!branch) {
    try {
      const url =
        parsed.host === 'github'
          ? `https://api.github.com/repos/${parsed.repo}`
          : `https://gitlab.com/api/v4/projects/${encodeURIComponent(parsed.repo)}`;
      const res = await net.fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) branch = (await res.json()).default_branch;
    } catch {
      /* 查询失败则回退 main */
    }
  }
  return tarballUrl(parsed, branch);
}

/**
 * 下载并解压 tarball 到插件存放目录（用系统 tar：Windows 10 1803+ / macOS / Linux 均内置）。
 * 只对「建立连接 + 收到响应头」设 30s 超时；正文流式写入临时文件，大仓库（数百 MB）不再被整体超时中断。
 */
async function downloadTarball(url, destDir) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await net.fetch(url, { signal: controller.signal });
  } catch (err) {
    throw new Error(`连接失败：${err.name === 'AbortError' ? '连接超时，请检查网络或代理' : err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);

  const tmp = path.join(os.tmpdir(), `dsh-plugin-${Date.now()}.tar.gz`);
  let total = 0;
  try {
    const reader = res.body.getReader();
    const ws = fs.createWriteStream(tmp);
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (!ws.write(Buffer.from(value))) {
        await new Promise((resolve) => ws.once('drain', resolve));
      }
      if (total - lastReport > 20 * 1024 * 1024) {
        lastReport = total;
        emitPluginOutput(`已下载 ${(total / 1048576).toFixed(0)} MB …\n`);
      }
    }
    await new Promise((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve()));
    });
    emitPluginOutput(`下载完成（${(total / 1048576).toFixed(1)} MB）\n`);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
    throw new Error(`下载中断：${err.message}`);
  }

  fs.mkdirSync(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', tmp, '-C', destDir], (err) => (err ? reject(new Error(`解压失败：${err.message}`)) : resolve()));
  });
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* 忽略 */
  }
}

/** 免 git 模式：下载源码到存放目录，定位 dsh bundle 子包并构建，返回可安装的包目录列表。 */
async function installFromTarball(spec) {
  const parsed = parseTarballSpec(spec);
  if (!parsed) throw new Error('仅支持 GitHub / GitLab 仓库地址的自动下载');
  const url = await resolveTarballUrl(spec);
  const repoName = parsed.repo.split('/').pop();
  const ref = parsed.ref || 'main';
  const destDir = path.join(getPluginsDir(), `${repoName}@${ref.replace(/[^\w.-]/g, '_')}`);
  if (!fs.existsSync(path.join(destDir, 'package.json'))) {
    emitPluginOutput(`正在下载 ${spec} → ${destDir}\n`);
    await downloadTarball(url, destDir);
  }
  // 解压内容通常包在 <repo>-<ref>/ 一层，找含 package.json 的顶层目录
  const entries = fs.readdirSync(destDir).map((e) => path.join(destDir, e));
  const root = entries.find((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'package.json')));
  const baseDir = root || destDir;

  // 收集声明 dsh.bundle 的包：根目录优先，再扫描子目录（支持 open-design 这类 monorepo）
  const bundles = findBundlePackages(baseDir);
  if (bundles.length === 0) {
    throw new Error(`仓库 ${parsed.repo} 中没有找到 dsh 插件（没有任何 package.json 声明 dsh.bundle）。若插件以 npm 发布，请直接填包名`);
  }

  // 逐个构建缺少入口产物的包，返回安装目标目录列表
  const targets = [];
  for (const b of bundles) {
    const res = await buildPackage(b.dir, b.pkg, emitPluginOutput);
    if (res.code !== 0) throw new Error(`插件 ${b.pkg.name || b.dir} 无法安装：${res.output || '未知错误'}`);
    if (res.skipped) emitPluginOutput(`\n${b.pkg.name || b.dir} 已就绪，无需构建\n`);
    targets.push(b.dir);
  }
  return targets;
}

/**
 * pnpm 默认阻止 git/本地插件的构建脚本（allowBuilds）。失败时自动解析被阻止的
 * 包名，写入 profile 的 pnpm-workspace.yaml（onlyBuiltDependencies）并重试一次。
 */
async function autoApproveBuildsAndRetry(spec, output) {
  const m = /(?:Cannot run scripts|Ignored build scripts|blocked by building scripts)[^\S\r\n]*[:：\-]?\s*([\w@./~-]+)/i.exec(output);
  const key = m && m[1].trim();
  if (!key || key.length > 120 || /\s/.test(key)) return null;

  const wsPath = path.join(DSH_HOME, 'profiles', 'web', 'pnpm-workspace.yaml');
  let yaml = '';
  try {
    yaml = fs.readFileSync(wsPath, 'utf8');
  } catch {
    yaml = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n';
  }
  if (!/onlyBuiltDependencies\s*:/.test(yaml)) {
    yaml = yaml.trimEnd() + `\n\nonlyBuiltDependencies:\n  - ${key}\n`;
  } else if (!new RegExp(`\\n\\s+-\\s*${escapeRegExp(key)}\\s*(?:\\n|$)`).test(yaml)) {
    yaml = yaml.replace(/(onlyBuiltDependencies\s*:\s*\n)/, `$1  - ${key}\n`);
  }
  fs.writeFileSync(wsPath, yaml);
  emitPluginOutput(`\n已自动允许构建脚本：${key}\n重试安装…\n`);
  return runPluginCommand(['add', spec]);
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
      let dependencies = {};
      try {
        const manifest = JSON.parse(fs.readFileSync(profilePkg, 'utf8'));
        bundles = manifest.dsh?.profile?.bundles ?? [];
        dependencies = manifest.dependencies ?? {};
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
        pluginsDir: getPluginsDir(),
      };
    });

    // 插件存放目录：读取 + 弹窗选择
    ipcMain.handle('settings:get-plugins-dir', () => ({ ok: true, dir: getPluginsDir() }));
    ipcMain.handle('settings:set-plugins-dir', async () => {
      const res = await dialog.showOpenDialog(settingsWindow, {
        title: '选择插件存放目录',
        defaultPath: getPluginsDir(),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || !res.filePaths[0]) return { ok: true, canceled: true };
      writeDesktopSettings({ pluginsDir: res.filePaths[0] });
      return { ok: true, dir: res.filePaths[0] };
    });

    // 检查 GitHub 最新 Release 并对比本地版本（GitHub 公开 API，无需鉴权）
    ipcMain.handle('settings:check-update', async () => {
      try {
        const res = await net.fetch(LATEST_RELEASE_API, {
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

    // 安装插件：支持 npm 包名、GitHub/GitLab 仓库地址、git 地址、本地路径。
    // 有 git 时走 pnpm 原生 git 依赖；无 git 时自动下载源码到插件存放目录再安装。
    // 安装成功后用 `dsh web --port 0` 做一次真实启动探测：注册了独立命令行接口的
    // 插件（如 open-design 这类 profile 级插件）会让 web 解析 --port 失败，需要自动回滚。
    ipcMain.handle('settings:install-plugin', async (_event, input) => {
      const norm = normalizePluginSpec(input);
      if (!norm) return { ok: false, message: '输入无效' };
      if (norm.mode === 'npm' && !/^(@[a-z0-9-~][\w.-]*\/)?[a-z0-9-~][\w.-]*(\/[\w.-]+)*$/.test(norm.spec)) {
        return { ok: false, message: '包名格式不正确' };
      }
      // 安装单个 spec，返回成功文案或 { error }。失败时先尝试自动放行被 pnpm 拦截的构建脚本。
      const addOne = async (spec) => {
        const res = await runPluginCommand(['add', spec]);
        if (res.code !== 0) {
          const retry = await autoApproveBuildsAndRetry(spec, res.output);
          if (retry && retry.code === 0) return '安装成功（已自动允许构建脚本），重启服务后生效';
          if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(res.output)) {
            return {
              error: '安装失败：git 的 HTTPS 证书验证被拦截（常见于代理/抓包工具）。可运行 git config --global http.sslVerify false 后重试，或改用 GitHub/GitLab 公开仓库地址',
            };
          }
          return { error: `安装失败（退出码 ${res.code}），可查看上方输出` };
        }
        return '安装成功，重启服务后生效';
      };
      const readDeps = () => {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'profiles', 'web', 'package.json'), 'utf8'));
          return Object.keys(m.dependencies ?? {});
        } catch {
          return [];
        }
      };
      const beforeDeps = readDeps();
      let success = null;
      let fail = null;
      try {
        if (norm.mode === 'tarball') {
          // 仓库源码免 git 下载 + 自动构建：已暂时停用（monorepo 共享构建依赖解析复杂，易失败）
          fail = { error: '仓库源码自动下载与构建已暂时停用，请改用 npm 包名安装，或使用 Git 地址 / 本地路径' };
        } else {
          if (norm.mode === 'git' && !(await isGitAvailable())) {
            fail = { error: '该地址需要系统 git，请先安装 git（或改用 npm 包名安装）' };
          } else {
            const r = await addOne(norm.spec);
            if (typeof r === 'string') success = r;
            else fail = { error: r.error };
          }
        }
      } catch (err) {
        fail = { error: err.message };
      }
      if (fail) return { ok: false, message: fail.error };
      // 安装成功 → 真实启动探测；与 web 冲突则自动回滚并提示
      const installed = readDeps().filter((k) => !beforeDeps.includes(k));
      const verify = await verifyWebBoot();
      if (!verify.ok) {
        for (const name of installed) removePluginFromManifest(name);
        emitPluginOutput(
          `\n[回滚] 插件 ${installed.join('、')} 与 web 启动冲突：${verify.reason}\n` +
            `它可能注册了独立的命令行接口（如 --stdio 等）或声明了不兼容的配置，不适合作为 web 插件，已自动移除。\n`
        );
        return { ok: false, message: `插件与 web 启动冲突，已自动移除（${verify.reason}）` };
      }
      return { ok: true, message: success };
    });

    ipcMain.handle('settings:remove-plugin', async (_event, name) => {
      if (!name || !/^[\w@./~-]+$/.test(name)) return { ok: false, message: '包名格式不正确' };
      const res = await runPluginCommand(['remove', name]);
      return { ok: res.code === 0, message: res.code === 0 ? '卸载成功' : `卸载失败（退出码 ${res.code}）` };
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
