// Browser half bundle（client-modules 契约 C6）：执行时只注册 factory，
// 模块体副作用在 materialization 时运行。格式对齐 dsh-client-ui-jobs 产物。
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-desktop-header-layout",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let { createElement: h, useSyncExternalStore } = react;

    const css = [
      ".dshdlHeader { padding: 40px 28px 0 20px; border-bottom: 1px solid var(--dsw-alias-divider-border); outline: 2px solid #ff8800; }",
      ".dshdlHeaderHidden { display: none; }",
      ".dshdlTitleRow { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 32px; }",
      ".dshdlCrumbs { display: flex; align-items: center; gap: 4px; min-width: 0; }",
      ".dshdlCrumbSeg { display: inline-flex; align-items: center; }",
      ".dshdlCrumb { padding: 0 6px; border: none; background: transparent; border-radius: 6px; font-size: 13px; line-height: 16px; color: var(--dsw-alias-label-tertiary); cursor: pointer; white-space: nowrap; }",
      ".dshdlCrumb:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }",
      ".dshdlCrumbCurrent { font-weight: 500; color: var(--dsw-alias-label-primary); cursor: default; }",
      ".dshdlCrumbSep { color: var(--dsw-alias-label-tertiary); }",
      ".dshdlActions { display: flex; flex: none; align-items: center; gap: 8px; }",
      ".dshdlActions:empty { display: none; }",
      ".dshdlTabs { display: flex; gap: 36px; margin-top: 4px; }",
      ".dshdlTab { position: relative; padding: 0 0 11px; border: none; background: transparent; font-size: 13px; line-height: 16px; font-weight: 500; color: var(--dsw-alias-label-tertiary); cursor: pointer; }",
      ".dshdlTab::after { content: ''; position: absolute; right: 0; bottom: 1px; left: 0; height: 2px; border-radius: 2px; background: transparent; }",
      ".dshdlTabActive { color: var(--dsw-alias-state-business-primary); }",
      ".dshdlTabActive::after { background: var(--dsw-alias-state-business-primary); }",
    ].join("\n");
    const cssTagId = "@deepseek-ai/dsh-desktop-header-layout/desktop-header.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@deepseek-ai/dsh-desktop-header-layout";
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---- 逻辑对齐 ui-conversation 的 ConversationSessionHeader，仅调整结构 ----
    const DEFAULT_VIEW_ID = "chat";

    function resolveActiveView(tabs, selectedId) {
      const requestedId = selectedId ?? DEFAULT_VIEW_ID;
      return (
        tabs.find((view) => view.id === requestedId)
        ?? tabs.find((view) => view.id === DEFAULT_VIEW_ID)
      );
    }

    function deriveAncestry(list, id) {
      const chain = [];
      const seen = new Set();
      let cursor = id;
      while (cursor !== undefined) {
        if (seen.has(cursor)) break;
        seen.add(cursor);
        const summary = list.byId[cursor];
        if (summary === undefined) break;
        chain.unshift({ id: summary.id, displayTitle: summary.displayTitle });
        if (summary.origin !== "subagent") break;
        cursor = summary.parentId;
      }
      return chain;
    }

    function equalBreadcrumbs(left, right) {
      return (
        left.length === right.length
        && left.every((item, index) => {
          const other = right.at(index);
          return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle;
        })
      );
    }

    // 遮蔽默认会话 header：面包屑独占第一行（顶部留出窗口拖动区），
    // actions/utilities 移到 Chat/Trajectory 导航行，样式对齐 tabs。
    function DesktopConversationHeader(props) {
      const {
        sessionId, useSession, useSessions, useStore, actions,
        renderSlot, views, open, t,
      } = props;
      // 防御：任何依赖缺失/抛错都会被 slots 边界捕获后静默 abdicate，
      // 从而回退渲染默认 header —— 全部兜底，确保我们的 entry 稳定存活。
      const safeViews = views ?? {
        subscribe: () => () => {},
        version: () => 0,
        list: () => [],
      };
      useSyncExternalStore(safeViews.subscribe, safeViews.version);
      const tabs = safeViews.list();
      const selectedId = typeof useStore === "function" ? useStore((s) => s.view) : undefined;
      const active = resolveActiveView(tabs, selectedId);
      const ancestry = typeof useSessions === "function"
        ? useSessions((s) => deriveAncestry(s, sessionId), equalBreadcrumbs)
        : [];
      const composerPhase = typeof useSession === "function" ? useSession((s) => s.composerPhase) : undefined;
      const blank = typeof useSession === "function" ? useSession((s) => s.blank) : undefined;
      const hideChrome = blank && composerPhase === "blank";

      if (hideChrome) {
        return h("header", { className: "dshdlHeader dshdlHeaderHidden" });
      }

      const crumbs = ancestry.map((summary, index) => {
        const last = index === ancestry.length - 1;
        return h("span", { key: summary.id, className: "dshdlCrumbSeg" },
          index > 0 && h("span", { className: "dshdlCrumbSep" }, "/"),
          h("button", {
            type: "button",
            className: last ? "dshdlCrumb dshdlCrumbCurrent" : "dshdlCrumb",
            disabled: last,
            onClick: () => open?.(summary.id),
          }, summary.displayTitle),
        );
      });
      if (ancestry.length === 0) {
        crumbs.push(h("span", { key: "root", className: "dshdlCrumbCurrent" }, sessionId));
      }

      const tabButtons = tabs.length > 1
        ? h("div", { className: "dshdlTabs", role: "tablist" },
            tabs.map((viewTab) => h("button", {
              key: viewTab.id,
              type: "button",
              role: "tab",
              "aria-selected": viewTab.id === active?.id,
              className: viewTab.id === active?.id ? "dshdlTab dshdlTabActive" : "dshdlTab",
              onClick: () => actions?.setView?.(viewTab.id),
            }, viewTab.label)),
          )
        : null;

      return h("header", { className: "dshdlHeader" },
        h("div", { className: "dshdlTitleRow" },
          h("nav", { className: "dshdlCrumbs", "aria-label": typeof t === "function" ? t("session.hierarchy") : "Session" }, crumbs),
          h("div", { className: "dshdlActions" }, renderSlot?.("conversation.session.header.actions", {}) ?? null),
        ),
        tabs.length > 1 ? tabButtons : null,
      );
    }

    exports.inject = ["slots"];
    exports.apply = function (ctx) {
      // 遮蔽默认 header：必须用不同 priority 注册（lowest 渲染）。
      // 默认条目在 0，这里用 -1 抢到最低优先级成为 winner。
      // 注意：不能重复声明 children —— 默认 header entry 的 actions/utilities
      // 声明依然有效（不随遮蔽失效），重复声明会 throw。
      ctx.slots.inject("conversation.session.header", () =>
        ctx.slots.register({
          name: "conversation.session.header",
          id: "desktop-header-layout",
          priority: -1,
        }, DesktopConversationHeader),
      );
    };

    return module.exports;
  },
});
