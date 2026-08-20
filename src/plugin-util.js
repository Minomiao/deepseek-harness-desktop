'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

/**
 * 插件安装的工具逻辑，独立于 Electron，便于单元测试。
 * 网络相关（代理、下载）由 main.js 处理。
 */

// 内置的独立 pnpm 二进制（@pnpm/exe），用于构建子包 / 转发 dsh plugin
const PNPM_DIR = path.dirname(require.resolve('@pnpm/exe/package.json'));
const PNPM_EXE = path.join(PNPM_DIR, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm');

/**
 * 把用户输入规范化为安装 spec。
 * GitHub/GitLab 公开仓库 → tarball 模式（免 git：HTTPS 下载源码，可靠且不弹黑窗）；
 * 其他 git 地址 → git 模式（需要系统 git）；npm 包名 / 本地路径 → 原样。
 * 支持：npm 包名 / @scope/name / user/repo（GitHub 简写）/ github:user/repo[#ref] /
 *       git+https:// / git+ssh:// / git:// / git@host:user/repo.git /
 *       https://github.com|gitlab.com/user/repo（含 /tree/<ref> 与 .git 结尾）/ 本地绝对路径
 * @returns {{mode: 'npm'|'git'|'tarball'|'file', spec: string} | null}
 */
function normalizePluginSpec(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // 本地路径
  if (path.isAbsolute(s) || /^[./~]/.test(s)) return { mode: 'file', spec: s };
  // git 协议
  if (/^(git\+|git:\/\/|ssh:\/\/)/.test(s)) return { mode: 'git', spec: s };
  // scp 风格 git@host:user/repo.git
  if (/^git@[\w.-]+:[\w.-]+\/[\w.-]+/.test(s)) {
    return { mode: 'git', spec: `git+ssh://${s.replace(/^git@([\w.-]+):/, 'git@$1/')}` };
  }
  // github:/gitlab: 简写 → 免 git 下载
  if (/^(github|gitlab):[\w.-]+\/[\w.-]+/.test(s)) return { mode: 'tarball', spec: s };
  // https:// 仓库 URL（含 /tree/<ref>，ref 可含斜杠）
  if (/^https?:\/\/[^\s]+$/.test(s)) {
    const m = /^https?:\/\/(github\.com|gitlab\.com)\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/tree\/(.+))?$/.exec(s);
    if (m) {
      const host = m[1] === 'github.com' ? 'github' : 'gitlab';
      const ref = m[3];
      return { mode: 'tarball', spec: ref ? `${host}:${m[2]}#${ref}` : `${host}:${m[2]}` };
    }
    // 其他 https 地址只能走 git
    return { mode: 'git', spec: s };
  }
  // user/repo 视为 GitHub 仓库简写 → 免 git 下载
  if (/^[\w.-]+\/[\w.-]+(?:\.[\w.-]+)?$/.test(s) && !s.startsWith('@')) {
    return { mode: 'tarball', spec: `github:${s}` };
  }
  // 其余按 npm 包名
  return { mode: 'npm', spec: s };
}

/** 解析 github:/gitlab: spec → {host, repo, ref}，失败返回 null。 */
function parseTarballSpec(spec) {
  const m = /^(github|gitlab):([\w.-]+\/[\w.-]+?)(?:#([^\s]+))?$/.exec(spec);
  if (!m) return null;
  return { host: m[1], repo: m[2], ref: m[3] };
}

/** 由解析结果 + 分支名生成免 git 的 tarball 下载地址。 */
function tarballUrl(parsed, branch) {
  const b = branch || parsed.ref || 'main';
  if (parsed.host === 'github') {
    return `https://codeload.github.com/${parsed.repo}/tar.gz/refs/heads/${b}`;
  }
  return `https://gitlab.com/${parsed.repo}/-/archive/${b}/${parsed.repo.split('/').pop()}-${b}.tar.gz`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- monorepo 子包定位与构建（open-design 这类仓库：根不是 bundle，子包才是） ----

/** 是否声明了 dsh bundle（与 dsh 的 exportsPatch 语义一致：存在 dsh.bundle.patch）。 */
function isBundleManifest(pkg) {
  return !!(pkg && pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch !== undefined);
}

const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage', '.turbo']);

/**
 * 在仓库目录里查找所有声明了 dsh.bundle 的包目录（含根目录）。
 * @returns {{dir: string, pkg: object}[]} 根优先、按扫描顺序；最多下探 4 层。
 */
function findBundlePackages(rootDir) {
  const found = [];
  const visit = (dir, depth) => {
    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      /* 该目录没有 package.json */
    }
    if (isBundleManifest(pkg)) found.push({ dir, pkg });
    if (depth >= 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || SKIP_SCAN_DIRS.has(e.name)) continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(rootDir, 0);
  return found;
}

/** 解析包的入口产物路径（main/exports 指向的 JS 文件），不存在则回退常见入口，都没有返回 null。 */
function resolveEntryFile(dir, pkg) {
  // 只认代码入口；dsh bundle 的 exports 常包含资源（cordis.patch.yml 等），不算构建产物
  const JS_EXT = /\.(?:mjs|cjs|js)$/i;
  const candidates = [];
  if (typeof pkg?.main === 'string' && pkg.main && JS_EXT.test(pkg.main)) candidates.push(pkg.main);
  const ex = pkg?.exports;
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    for (const key of Object.keys(ex)) {
      const v = ex[key];
      if (typeof v === 'string') {
        if (JS_EXT.test(v)) candidates.push(v);
      } else if (v && typeof v === 'object') {
        for (const k of ['default', 'import', 'require']) {
          if (typeof v[k] === 'string' && JS_EXT.test(v[k])) candidates.push(v[k]);
        }
      }
    }
  }
  for (const c of candidates) {
    const p = path.resolve(dir, c);
    if (fs.existsSync(p)) return p;
  }
  for (const c of ['index.js', 'index.mjs', 'index.cjs', 'dist/index.js']) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 在指定目录执行内置 pnpm（构建子包用）。onOutput 可选，逐行转发输出。 */
function runPnpmIn(dir, args, onOutput) {
  return new Promise((resolve) => {
    const child = spawn(PNPM_EXE, args, {
      cwd: dir,
      env: { ...process.env, PATH: PNPM_DIR + path.delimiter + (process.env.PATH || '') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    const collect = (buf) => {
      const text = buf.toString();
      output += text;
      if (onOutput) onOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** pnpm 默认拦截依赖的构建脚本；从失败输出解析被阻止的包名，写入 onlyBuiltDependencies 后重试。 */
async function approveBuildScripts(dir, output, onOutput) {
  const m = /(?:Cannot run scripts|Ignored build scripts|blocked by building scripts)[^\S\r\n]*[:：\-]?\s*([\w@./~-]+)/i.exec(output);
  const key = m && m[1].trim();
  if (!key || key.length > 120 || /\s/.test(key)) return null;
  const wsPath = path.join(dir, 'pnpm-workspace.yaml');
  let yaml = '';
  try {
    yaml = fs.readFileSync(wsPath, 'utf8');
  } catch {
    yaml = 'packages:\n  - .\n\nnodeLinker: hoisted\n';
  }
  if (!/onlyBuiltDependencies\s*:/.test(yaml)) {
    yaml = yaml.trimEnd() + `\n\nonlyBuiltDependencies:\n  - ${key}\n`;
  } else if (!new RegExp(`\\n\\s+-\\s*${escapeRegExp(key)}\\s*(?:\\n|$)`).test(yaml)) {
    yaml = yaml.replace(/(onlyBuiltDependencies\s*:\s*\n)/, `$1  - ${key}\n`);
  }
  fs.writeFileSync(wsPath, yaml);
  if (onOutput) onOutput(`已自动允许构建脚本：${key}，重试安装…\n`);
  return key;
}

/** 截断过长的构建/安装输出，保留首尾便于排查。 */
function truncate(s, max = 2500) {
  if (!s || s.length <= max) return s;
  return `${s.slice(0, 600)}\n…（中间省略 ${s.length - max} 字符）…\n${s.slice(-(max - 600))}`;
}

/** 从目录向上找最近的含 pnpm-workspace.yaml 的目录（含自身）；没有则返回 null。 */
function findWorkspaceRoot(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, 'pnpm-workspace.yaml'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * 构建一个插件子包：入口产物缺失时执行 pnpm install + pnpm run build。
 * @returns {Promise<{code: number, output?: string, skipped?: boolean}>}
 */
async function buildPackage(dir, pkg, onOutput) {
  const entry = resolveEntryFile(dir, pkg);
  const hasBuild = typeof pkg?.scripts?.build === 'string';
  if (entry) return { code: 0, skipped: true }; // 产物已就绪

  // 确保目标子包被当作独立 workspace：避免 pnpm 上溯到 monorepo 根，
  // 误把整个仓库（几百个依赖）当成 workspace 安装。
  // monorepo 子包：把独立 workspace 建在仓库根（只含目标子包），这样
  // shared/ 等共享构建配置从根目录解析依赖（如 lightningcss）时不落空；
  // 依赖装在仓库根 node_modules，构建脚本仍在子包目录执行。
  const wsRoot = findWorkspaceRoot(dir);
  const installDir = wsRoot && wsRoot !== dir ? wsRoot : dir;
  const wsPath = path.join(installDir, 'pnpm-workspace.yaml');
  let wsContent = null;
  try {
    wsContent = fs.readFileSync(wsPath, 'utf8');
  } catch {
    /* 目录里没有 pnpm-workspace.yaml */
  }
  const hasOwnWorkspace = !!wsContent && /packages\s*:/.test(wsContent);
  if (installDir !== dir) {
    if (onOutput) onOutput(`\n[构建 ${pkg?.name || dir}] 子包独立构建：清理被上层 workspace 污染的依赖…\n`);
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    fs.rmSync(path.join(installDir, 'node_modules'), { recursive: true, force: true });
    const rel = path.relative(installDir, dir).split(path.sep).join('/');
    const entries = [`./${rel}`];
    const sharedDir = path.join(installDir, 'shared');
    if (fs.existsSync(path.join(sharedDir, 'package.json'))) entries.push('./shared');
    // verifyDepsBeforeRun: false —— 禁用 pnpm run build 前的依赖状态检查（其内部 install 不带低并发参数，易被镜像中断）
    fs.writeFileSync(
      wsPath,
      `packages:\n${entries.map((e) => `  - ${e}`).join('\n')}\n\nnodeLinker: hoisted\nverifyDepsBeforeRun: false\n`
    );
  } else if (!hasOwnWorkspace) {
    if (onOutput) onOutput(`\n[构建 ${pkg?.name || dir}] 子包独立构建：清理被上层 workspace 污染的依赖…\n`);
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    fs.writeFileSync(wsPath, 'packages:\n  - .\n\nnodeLinker: hoisted\nverifyDepsBeforeRun: false\n');
  } else if (!/verifyDepsBeforeRun\s*:/.test(wsContent)) {
    fs.appendFileSync(wsPath, '\nverifyDepsBeforeRun: false\n');
  }

  if (!hasBuild) {
    return { code: 1, output: `${pkg?.name || dir} 缺少构建产物（入口文件不存在），且没有 build 脚本，无法自动构建` };
  }
  // 低并发 + 多重试：pnpm 会下载所有平台的 optional 二进制包，高并发下易被镜像/代理中断（UND_ERR_DESTROYED）
  const INSTALL_ARGS = ['install', '--no-frozen-lockfile', '--network-concurrency=4', '--fetch-retries=5'];
  if (!fs.existsSync(path.join(installDir, 'node_modules'))) {
    if (onOutput) onOutput(`\n[构建 ${pkg?.name || dir}] 安装依赖…\n`);
    let r = await runPnpmIn(installDir, INSTALL_ARGS, onOutput);
    if (r.code !== 0) {
      const key = await approveBuildScripts(installDir, r.output, onOutput);
      if (key) r = await runPnpmIn(installDir, INSTALL_ARGS, onOutput);
    }
    if (r.code !== 0) return { code: 1, output: `安装依赖失败（退出码 ${r.code}）\n${truncate(r.output)}` };
  }
  if (onOutput) onOutput(`\n[构建 ${pkg?.name || dir}] pnpm run build …\n`);
  const r = await runPnpmIn(dir, ['run', 'build'], onOutput);
  if (r.code !== 0) return { code: 1, output: `构建失败（退出码 ${r.code}）\n${truncate(r.output)}` };
  if (!resolveEntryFile(dir, pkg)) {
    return { code: 1, output: `构建完成但入口文件仍不存在（${pkg?.name || dir} 的 main/exports 与实际产物不一致）` };
  }
  return { code: 0, skipped: false };
}

module.exports = {
  normalizePluginSpec,
  parseTarballSpec,
  tarballUrl,
  escapeRegExp,
  isBundleManifest,
  findBundlePackages,
  resolveEntryFile,
  runPnpmIn,
  buildPackage,
};
