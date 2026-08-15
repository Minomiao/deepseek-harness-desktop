'use strict';

// loading 页脚本：通过 preload 暴露的 dshDesktop 订阅启动状态
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const spinnerEl = document.getElementById('spinner');

function render(state) {
  if (!state) return;
  if (state.status === 'ready') {
    statusEl.textContent = `服务已就绪，正在打开 ${state.url}`;
    return;
  }
  if (state.status === 'error') {
    spinnerEl.style.display = 'none';
    statusEl.textContent = '启动失败';
    errorEl.textContent = state.error || '未知错误';
    return;
  }
  statusEl.textContent = '正在启动本地 dsh web 服务（首次运行需初始化 profile，请稍候）';
}

window.dshDesktop.getState().then(render);
window.dshDesktop.onState(render);
