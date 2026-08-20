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
const versionEl = document.getElementById('version');

let busy = false;

// 内置 bundle（dsh 自带的 web 基础层），不可卸载
const BUILTIN_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

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
  dshHomeEl.textContent = info.dshHome;
  versionEl.textContent = `DSH Desktop v${info.version} · DeepSeek Harness`;
  autoLaunchEl.checked = info.autoLaunch;

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

// 主题实时跟随：主进程在 dsh 主题变化时推送
api.onTheme(applyTheme);
loadInfo();
