// Browser half bundle（client-modules 契约）：执行时只注册 factory，
// 模块体副作用在 materialization 时运行。格式对齐 dsh-client-ui-jobs 产物。
// 纯 DOM 实现（无 React）：监听对话滚动容器与消息行，注入右侧导航点 rail。
// 只显示用户消息（user/steering）；最多 10 个点，超出后 rail 可滚轮滚动。
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-desktop-chat-navdots",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const CSS = [
      // rail：默认隐藏溢出；悬停时才允许纵向滚动（此时横向不裁剪，气泡可伸出）
      ".dshndRail { position: fixed; right: 6px; top: 50%; transform: translateY(-50%); z-index: 40; display: flex; flex-direction: column; gap: 9px; padding: 6px 3px; border-radius: 10px; overflow: hidden; scrollbar-width: none; max-height: 70vh; justify-content: flex-start; overscroll-behavior: contain; }",
      ".dshndRail::-webkit-scrollbar { display: none; }",
      ".dshndDot { position: relative; width: 5px; height: 5px; flex: 0 0 auto; border-radius: 50%; border: none; padding: 0; background: var(--dsw-alias-label-tertiary, #9aa0a6); opacity: 0.45; cursor: pointer; transition: opacity .15s, transform .15s, background .15s; }",
      ".dshndDot:hover { opacity: 1; transform: scale(1.6); background: var(--dsw-alias-state-business-primary, #4d6bfe); }",
      ".dshndDotActive { opacity: 1; background: var(--dsw-alias-state-business-primary, #4d6bfe); transform: scale(1.5); }",
      // 气泡挂 body 级（fixed），脱离 rail 裁剪上下文；单行内容预览（无序号/类型行）
      ".dshndTip { position: fixed; z-index: 60; width: 168px; max-width: 45vw; padding: 5px 9px; border-radius: 8px; background: var(--dsw-alias-container-raised, #ffffff); color: var(--dsw-alias-label-primary, #1f2329); border: 1px solid var(--dsw-alias-divider-border, rgba(0,0,0,.1)); box-shadow: 0 2px 10px rgba(0,0,0,.12); font-size: 10px; line-height: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; display: none; }",
    ].join("\n");
    const CSS_ID = "@deepseek-ai/dsh-desktop-chat-navdots/rail.css";

    // ---- 工具 ----

    function findScrollport() {
      // ui-conversation 的滚动容器带 data-conversation-scroll（ConversationRoot scrollBody）。
      const direct = document.querySelector("[data-conversation-scroll]");
      if (direct) return direct;
      const byClass = [...document.querySelectorAll('[class*="_scroll"]')].find((el) => el.scrollHeight > el.clientHeight + 8);
      return byClass ?? null;
    }

    /** 收集用户消息行：`[class$="_userRow"]` 是 UserStyleBubble 的稳定 CSS Modules 后缀。
     *  必须有可见内容（排除空行/隐形节点），归属到最近的 chat 行（data-chat-anchor-key）。 */
    function collectRows(scrollport) {
      const rows = [];
      for (const row of scrollport.querySelectorAll("[data-chat-anchor-key]")) {
        const kind = row.dataset.chatFlowKind;
        if (kind !== "user" && kind !== "steering") continue;
        const bubble = row.querySelector('[class$="_userRow"]');
        if (!bubble) continue; // 行存在但没有用户气泡（如空消息/未渲染）→ 跳过
        rows.push({ el: row, kind, key: row.dataset.chatAnchorKey, bubble });
      }
      return rows;
    }

    /** 内容签名：行数 + 每行 anchor key + 类型。只有签名变化才重建 rail。 */
    function rowsSignature(rows) {
      return rows.map((r) => `${r.key}:${r.kind}`).join("|");
    }

    // 常见日期/时间形态：2026/8/26、2026-08-26、14:05、14:05:30、上午/下午 2:30 等
    const DATETIME_RE = /(\d{1,4}[/年.\-]\d{1,2}([/月.\-]\d{1,4})?|\d{1,2}:\d{2}(:\d{2})?|[上下]午\s*\d{1,2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2}(,?\s+\d{4})?)/g;

    /** 预览文本：只取用户气泡内容，并剥离日期/时间片段。 */
    function previewText(row) {
      const source = row.bubble || row;
      const text = (source.innerText || "").replace(DATETIME_RE, " ").replace(/\s+/g, " ").trim();
      return text.length > 80 ? text.slice(0, 80) + "…" : (text || "（空消息）");
    }

    const state = {
      rail: null,
      tip: null,
      port: null,
      rows: [],
      sig: "",
      rafId: 0,
      timerId: 0,
      // 观察回调期间置 true：本次 mutation 由自身 rail 更新引起，跳过
      selfMutating: false,
    };

    function activeIdx() {
      const { rows, port } = state;
      if (!port || rows.length === 0) return -1;
      const portRect = port.getBoundingClientRect();
      const center = portRect.top + portRect.height / 2;
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].el.getBoundingClientRect();
        if (r.height === 0) continue;
        const d = Math.abs(r.top + r.height / 2 - center);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    }

    /** 把当前激活消息对应的点滚进 rail 可视区（点数超出 rail 高度时）。 */
    function scrollActiveIntoView() {
      const { rail } = state;
      if (!rail || rail.scrollHeight <= rail.clientHeight) return;
      const active = rail.querySelector(".dshndDotActive");
      if (active) active.scrollIntoView({ block: "nearest" });
    }

    function markActive() {
      state.rafId = 0;
      const { rail, rows } = state;
      if (!rail) return;
      const idx = activeIdx();
      for (const dot of rail.children) {
        const i = Number(dot.dataset.rowIdx);
        dot.classList.toggle("dshndDotActive", i === idx);
      }
      scrollActiveIntoView();
    }

    /** 悬停显示气泡：气泡是 body 级 fixed 元素，定位到点左侧。只显示消息内容单行。 */
    function bindTip(dot, row) {
      const show = () => {
        if (!state.tip) {
          state.tip = document.createElement("div");
          state.tip.className = "dshndTip";
          state.tip.dataset.dshnd = "";
          document.body.appendChild(state.tip);
        }
        const tip = state.tip;
        const body = document.createElement("span");
        body.textContent = previewText(row);
        state.selfMutating = true;
        try { tip.replaceChildren(body); } finally { state.selfMutating = false; }
        const rect = dot.getBoundingClientRect();
        tip.style.right = `${Math.max(4, window.innerWidth - rect.left + 8)}px`;
        tip.style.display = "block";
        // 先显示再量高度，保证气泡纵向精确居中于圆点
        tip.style.top = `${Math.max(4, rect.top + rect.height / 2 - tip.offsetHeight / 2)}px`;
      };
      const hide = () => { if (state.tip) state.tip.style.display = "none"; };
      dot.addEventListener("mouseenter", show);
      dot.addEventListener("mouseleave", hide);
      dot.addEventListener("focus", show);
      dot.addEventListener("blur", hide);
    }

    function render() {
      const { rows, rail } = state;
      if (!rail) return;
      if (rows.length < 1) { rail.style.display = "none"; return; }
      rail.style.display = "";

      const frag = document.createDocumentFragment();
      for (let i = 0; i < rows.length; i++) {
        const { el } = rows[i];
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "dshndDot";
        dot.dataset.rowIdx = String(i);
        bindTip(dot, rows[i]);
        dot.addEventListener("click", () => {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        frag.appendChild(dot);
      }
      // 标记自身操作，MutationObserver 回调里跳过
      state.selfMutating = true;
      try { rail.replaceChildren(frag); } finally { state.selfMutating = false; }
      markActive();
    }

    function onScroll() {
      if (!state.rafId) state.rafId = requestAnimationFrame(markActive);
    }

    /** 全量同步：port 变了重挂 scroll 监听；签名变化才重建 rail（滚动不重建）。 */
    function sync() {
      state.timerId = 0;
      const next = findScrollport();
      if (next !== state.port) {
        if (state.port) state.port.removeEventListener("scroll", onScroll);
        state.port = next;
        if (state.port) state.port.addEventListener("scroll", onScroll, { passive: true });
      }
      if (!state.port) {
        if (state.rail) state.rail.style.display = "none";
        return;
      }
      if (!state.rail || !state.rail.isConnected) {
        state.rail = document.createElement("div");
        state.rail.className = "dshndRail";
        state.rail.dataset.dshnd = "";
        state.selfMutating = true;
        try { document.body.appendChild(state.rail); } finally { state.selfMutating = false; }
      }
      const rows = collectRows(state.port);
      const sig = rowsSignature(rows);
      if (sig !== state.sig) {
        state.rows = rows;
        state.sig = sig;
        render();
      } else {
        // 行没变：仅刷新元素引用与高亮（流式输出可能替换行内 DOM 但 key 不变）
        state.rows = rows;
        markActive();
      }
    }

    const scheduleSync = () => {
      if (state.selfMutating) return; // 自身 rail 更新引起的 mutation：忽略
      if (!state.timerId) state.timerId = setTimeout(sync, 200);
    };

    function apply() {
      if (typeof document === "undefined") return;
      // 样式注入（幂等）
      if (!document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "@deepseek-ai/dsh-desktop-chat-navdots";
        tag.dataset.pluginCss = CSS_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
      // SPA：会话切换/消息增删都反映为 DOM 变化；body 兜底观察（可能晚于 apply，等 body 就绪）
      const start = () => {
        const mo = new MutationObserver((muts) => {
          // 自身 rail/气泡的更新：忽略
          if (muts.every((m) => m.target.closest?.(".dshndRail") || m.target.closest?.(".dshndTip") || (m.target.dataset?.dshnd !== undefined))) return;
          scheduleSync();
        });
        mo.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("resize", scheduleSync);
        sync();
      };
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  },
});
