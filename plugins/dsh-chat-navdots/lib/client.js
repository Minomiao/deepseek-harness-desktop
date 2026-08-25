// Browser half bundle（client-modules 契约）：执行时只注册 factory，
// 模块体副作用在 materialization 时运行。格式对齐 dsh-client-ui-jobs 产物。
// 纯 DOM 实现（无 React）：监听对话滚动容器与消息行，注入右侧导航点 rail。
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-desktop-chat-navdots",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const CSS = [
      ".dshndRail { position: fixed; right: 6px; top: 50%; transform: translateY(-50%); z-index: 40; display: flex; flex-direction: column; gap: 9px; padding: 6px 3px; border-radius: 10px; max-height: 70vh; overflow: hidden; justify-content: center; }",
      ".dshndRail:hover { overflow: visible; }",
      ".dshndDot { position: relative; width: 5px; height: 5px; border-radius: 50%; border: none; padding: 0; background: var(--dsw-alias-label-tertiary, #9aa0a6); opacity: 0.45; cursor: pointer; transition: opacity .15s, transform .15s, background .15s; }",
      ".dshndDot:hover { opacity: 1; transform: scale(1.6); background: var(--dsw-alias-state-business-primary, #4d6bfe); }",
      ".dshndDotActive { opacity: 1; background: var(--dsw-alias-state-business-primary, #4d6bfe); transform: scale(1.5); }",
      ".dshndTip { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); width: 120px; max-width: 40vw; padding: 3px 6px; border-radius: 5px; background: var(--dsw-alias-container-raised, #ffffff); color: var(--dsw-alias-label-primary, #1f2329); border: 1px solid var(--dsw-alias-divider-border, rgba(0,0,0,.1)); box-shadow: 0 2px 8px rgba(0,0,0,.1); font-size: 7px; line-height: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; display: none; }",
      ".dshndDot:hover .dshndTip, .dshndDot:focus-visible .dshndTip { display: block; }",
      ".dshndTipKind { display: block; font-size: 8px; color: var(--dsw-alias-label-tertiary, #9aa0a6); margin-bottom: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ].join("\n");
    const CSS_ID = "@deepseek-ai/dsh-desktop-chat-navdots/rail.css";

    // ---- 工具 ----
    const KIND_LABEL = { user: "你", steering: "转向", context: "上下文", "assistant-step": "助手", command: "命令" };
    const KINDS = new Set(["user", "steering", "context", "assistant-step", "command"]);
    const MAX_DOTS = 24;

    function findScrollport() {
      // ui-conversation 的滚动容器带 data-conversation-scroll（ConversationRoot scrollBody）。
      const direct = document.querySelector("[data-conversation-scroll]");
      if (direct) return direct;
      const byClass = [...document.querySelectorAll('[class*="_scroll"]')].find((el) => el.scrollHeight > el.clientHeight + 8);
      return byClass ?? null;
    }

    function collectRows(scrollport) {
      const rows = [];
      for (const row of scrollport.querySelectorAll("[data-chat-anchor-key]")) {
        const kind = row.dataset.chatFlowKind;
        if (kind && KINDS.has(kind)) rows.push({ el: row, kind, key: row.dataset.chatAnchorKey });
      }
      return rows;
    }

    /** 内容签名：行数 + 每行 anchor key + 类型。只有签名变化才重建 rail。 */
    function rowsSignature(rows) {
      return rows.map((r) => `${r.key}:${r.kind}`).join("|");
    }

    function previewText(row) {
      const text = (row.innerText || "").replace(/\s+/g, " ").trim();
      return text.length > 60 ? text.slice(0, 60) + "…" : (text || "（空消息）");
    }

    const state = {
      rail: null,
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
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].el.getBoundingClientRect();
        if (r.height === 0) continue;
        const d = Math.abs(r.top + r.height / 2 - center);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    }

    function markActive() {
      state.rafId = 0;
      const { rail, rows } = state;
      if (!rail) return;
      const idx = activeIdx();
      const stride = Math.ceil(rows.length / MAX_DOTS);
      for (const dot of rail.children) {
        const i = Number(dot.dataset.rowIdx);
        const last = i + stride >= rows.length;
        dot.classList.toggle("dshndDotActive", i === idx || (last && idx >= i));
      }
    }

    function render() {
      const { rows, rail } = state;
      if (!rail) return;
      if (rows.length < 2) { rail.style.display = "none"; return; }
      rail.style.display = "";

      // 超过 MAX_DOTS 个点时抽稀，保持 rail 简洁
      const stride = Math.ceil(rows.length / MAX_DOTS);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < rows.length; i += stride) {
        const { el, kind } = rows[i];
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "dshndDot";
        dot.dataset.rowIdx = String(i);
        const tip = document.createElement("span");
        tip.className = "dshndTip";
        const kindLabel = document.createElement("span");
        kindLabel.className = "dshndTipKind";
        kindLabel.textContent = `#${i + 1} · ${KIND_LABEL[kind] ?? kind}`;
        const body = document.createElement("span");
        body.textContent = previewText(el);
        tip.append(kindLabel, body);
        dot.appendChild(tip);
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
          // 全部由自身 rail 引起才跳过；混有其他变化（如流式输出）则照常调度
          if (muts.every((m) => m.target.closest?.(".dshndRail") || (m.target.dataset?.dshnd !== undefined && m.target === state.rail))) return;
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
