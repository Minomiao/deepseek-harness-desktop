'use strict';

const api = window.settingsAPI;

const pkgInput = document.getElementById('pkg');
const btnInstall = document.getElementById('btn-install');
const btnRemove = document.getElementById('btn-remove');
const btnRestart = document.getElementById('btn-restart');
const outputEl = document.getElementById('output');
const statusEl = document.getElementById('status');
const pluginsEl = document.getElementById('plugins');
const autoLaunchEl = document.getElementById('autolaunch');
const dshHomeEl = document.getElementById('dsh-home');
const btnOpenDir = document.getElementById('btn-open-dir');

const sideVersionEl = document.getElementById('side-version');
const aboutVersionEl = document.getElementById('about-version');
const aboutDshVersionEl = document.getElementById('about-dsh-version');
const aboutElectronEl = document.getElementById('about-electron');
const aboutChromiumEl = document.getElementById('about-chromium');
const aboutNodeEl = document.getElementById('about-node');
const btnCheckUpdate = document.getElementById('btn-check-update');
const btnGithub = document.getElementById('btn-github');
const btnReleases = document.getElementById('btn-releases');
const updateResultEl = document.getElementById('update-result');

let busy = false;
let repoUrl = 'https://github.com/Minomiao/deepseek-harness-desktop';

// 内置 bundle（dsh 自带的 web 基础层），不可卸载
const BUILTIN_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

// ---- 左侧竖导航切换 ----
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => {
      p.hidden = p.id !== `panel-${btn.dataset.panel}`;
    });
  });
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function setBusy(b) {
  busy = b;
  btnInstall.disabled = b;
  btnRemove.disabled = b;
  btnRestart.disabled = b;
  pkgInput.disabled = b;
}

function showStatus(text, ok) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = ok ? 'ok' : 'err';
}

function clearOutput() {
  outputEl.hidden = true;
  outputEl.textContent = '';
}

async function loadInfo() {
  const info = await api.getInfo();
  applyTheme(info.theme || 'light');
  if (info.repo) repoUrl = info.repo;
  dshHomeEl.textContent = info.dshHome;
  autoLaunchEl.checked = info.autoLaunch;

  sideVersionEl.textContent = info.version;
  aboutVersionEl.textContent = `v${info.version}`;
  aboutDshVersionEl.textContent = info.dshVersion || '未知';
  aboutElectronEl.textContent = info.electron || '';
  aboutChromiumEl.textContent = info.chromium || '';
  aboutNodeEl.textContent = info.node || '';

  pluginsEl.textContent = '';
  if (info.bundles.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '（无）';
    pluginsEl.appendChild(li);
    return;
  }
  for (const name of info.bundles) {
    const li = document.createElement('li');

    const span = document.createElement('span');
    span.textContent = name;
    li.appendChild(span);

    const isBuiltin = BUILTIN_BUNDLES.has(name);
    const tag = document.createElement('span');
    tag.className = isBuiltin ? 'tag builtin' : 'tag';
    tag.textContent = isBuiltin ? '内置' : '插件';
    li.appendChild(tag);

    if (!isBuiltin) {
      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.textContent = '移除';
      rm.addEventListener('click', async () => {
        if (!confirm(`确定卸载 ${name} 吗？`)) return;
        clearOutput();
        statusEl.hidden = true;
        setBusy(true);
        const off = api.onPluginOutput((line) => {
          outputEl.hidden = false;
          outputEl.textContent += line;
        });
        try {
          const res = await api.removePlugin(name);
          showStatus(res.message, res.ok);
          if (res.ok) loadInfo();
        } catch (err) {
          showStatus('发生错误：' + err.message, false);
        } finally {
          off();
          setBusy(false);
        }
      });
      li.appendChild(rm);
    }

    pluginsEl.appendChild(li);
  }
}

function run(action, args) {
  clearOutput();
  statusEl.hidden = true;
  setBusy(true);

  const off = api.onPluginOutput((line) => {
    outputEl.hidden = false;
    outputEl.textContent += line;
  });

  return api[action](...args)
    .then((res) => {
      showStatus(res.message, res.ok);
      if (res.ok) loadInfo();
    })
    .catch((err) => {
      showStatus('发生错误：' + err.message, false);
    })
    .finally(() => {
      off();
      setBusy(false);
    });
}

btnInstall.addEventListener('click', () => {
  const name = pkgInput.value.trim();
  if (!name) {
    showStatus('请输入插件包名', false);
    return;
  }
  run('installPlugin', [name]);
});

btnRemove.addEventListener('click', () => {
  const name = pkgInput.value.trim();
  if (!name) {
    showStatus('请输入要卸载的插件包名', false);
    return;
  }
  if (!confirm(`确定卸载 ${name} 吗？`)) return;
  run('removePlugin', [name]);
});

btnRestart.addEventListener('click', () => {
  setBusy(true);
  statusEl.hidden = true;
  api
    .restartDsh()
    .then(() => showStatus('正在重启 dsh 服务，主窗口会重新加载…', true))
    .catch((err) => showStatus('重启失败：' + err.message, false))
    .finally(() => setBusy(false));
});

autoLaunchEl.addEventListener('change', () => {
  api.setAutoLaunch(autoLaunchEl.checked);
});

btnOpenDir.addEventListener('click', () => {
  api.openDataDir();
});

// ---- 关于：检查更新 / 外链 ----
btnCheckUpdate.addEventListener('click', async () => {
  btnCheckUpdate.disabled = true;
  updateResultEl.hidden = false;
  updateResultEl.textContent = '正在检查更新…';
  try {
    const res = await api.checkUpdate();
    if (!res.ok) {
      updateResultEl.textContent = '检查更新失败：' + (res.error || '网络异常，请稍后重试');
    } else if (res.hasUpdate) {
      updateResultEl.textContent = `发现新版本 v${res.latest}（当前 v${res.current}）\n\n${res.notes || '（该版本暂无 Release 说明）'}\n\n下载地址：${res.url}`;
    } else {
      updateResultEl.textContent = `已是最新版本 v${res.current}`;
    }
  } catch (err) {
    updateResultEl.textContent = '检查更新失败：' + err.message;
  } finally {
    btnCheckUpdate.disabled = false;
  }
});

btnGithub.addEventListener('click', () => api.openExternal(repoUrl));
btnReleases.addEventListener('click', () => api.openExternal(repoUrl + '/releases'));

// 主题实时跟随：主进程在 dsh 主题变化时推送
api.onTheme(applyTheme);
loadInfo();
