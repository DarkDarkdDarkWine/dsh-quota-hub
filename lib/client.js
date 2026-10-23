/**
 * dsh-glm-quota — 界面端（聚合版：GLM + MiniMax）。
 *
 * 手写 wrapper，不经构建：DSH 用 window.__ModuleLoader__ 加载它，
 * require("react") 由宿主提供。这里只做三件事：
 *
 *   1. sidebar.footer.action  — 侧边栏底部徽标：每家 provider 一段百分比
 *   2. conversation.composer.dock — 聊天输入框下方胶囊：仅当本会话切到
 *      对应模型时出现（GLM 模型显示 GLM 额度，MiniMax 模型显示 MiniMax 额度）
 *   3. settings.section       — 「额度监控」设置页：每家 provider 一张卡
 *      （窗口进度、重置时间、Key 复用状态、区域切换）
 *
 * 数据全部来自宿主端 /dsh-glm-quota/*.json，界面端不直接访问外网，
 * 也不持有 Key。
 *
 * 宿主端 payload 形状：
 *   { ok, config: { version, intervalSeconds, enabled,
 *       providers: [{ id, label, region, regionLabel, regionOptions, keyRef,
 *                     customKeyRef, defaultKeyRef, enabled }] },
 *     providers: [ { provider, label, ok, fetchedAt, region, regionLabel,
 *       level, plan, windows[], extras[], worstWindowId, worstUsedPercent,
 *       error, needsKey, disabled?, key: { ref, configured, source, writable } } ] }
 */
window.__ModuleLoader__.load({
  id: "dsh-glm-quota",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    const BASE = "/dsh-glm-quota";
    const POLL_MS = 30_000;

    /** 界面端的 provider 元数据：匹配规则用来判断当前会话模型属于哪家。 */
    const PROVIDER_UI = {
      glm: { id: "glm", label: "GLM", labelShort: "GLM", match: /zai|bigmodel|zhipu|glm/i },
      minimax: { id: "minimax", label: "MiniMax", labelShort: "MM", match: /minimax|minimaxi|abab/i },
    };

    // ---- 共享 store：徽标和设置页看同一份数据、走同一个轮询 ----

    const store = {
      state: { loading: true, refreshing: false, payload: null, error: null },
      listeners: new Set(),
      timer: null,
      started: false,
    };

    function emit(patch) {
      store.state = Object.assign({}, store.state, patch);
      for (const listener of store.listeners) listener();
    }

    function absorb(payload) {
      // 传输层错误（连不上宿主）才进 store.error；单家查询失败在各自卡片里显示。
      const failed = payload === null || typeof payload !== "object" || payload.ok === false;
      emit({ loading: false, refreshing: false, payload: failed ? null : payload, error: failed ? String(payload && payload.error) || "宿主端返回异常" : null });
    }

    async function loadOnce() {
      try {
        const res = await fetch(BASE + "/status.json", { headers: { accept: "application/json" }, cache: "no-store" });
        absorb(await res.json());
      } catch (cause) {
        emit({ loading: false, error: "无法连接宿主端：" + String(cause) });
      }
    }

    async function refreshNow() {
      if (store.state.refreshing) return;
      emit({ refreshing: true });
      try {
        const res = await fetch(BASE + "/refresh.json", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        absorb(await res.json());
      } catch (cause) {
        emit({ refreshing: false, error: "刷新失败：" + String(cause) });
      }
    }

    async function saveConfig(patch) {
      const res = await fetch(BASE + "/config.json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await res.json();
      if (payload === null || typeof payload !== "object" || payload.ok === false) {
        throw new Error(payload && payload.error ? String(payload.error) : "保存失败");
      }
      absorb(payload);
      return payload;
    }

    function start() {
      if (store.started) return;
      store.started = true;
      void loadOnce();
      store.timer = setInterval(() => {
        if (store.listeners.size > 0) void loadOnce();
      }, POLL_MS);
    }

    function stop() {
      if (store.timer !== null) {
        clearInterval(store.timer);
        store.timer = null;
      }
      store.started = false;
    }

    function subscribe(listener) {
      store.listeners.add(listener);
      start();
      return () => {
        store.listeners.delete(listener);
        if (store.listeners.size === 0) stop();
      };
    }

    function useQuota() {
      const [state, setLocal] = react.useState(store.state);
      react.useEffect(() => subscribe(() => setLocal(store.state)), []);
      return state;
    }

    // ---- 小工具 ----

    const SEVERITY_COLOR = {
      ok: "var(--dsw-alias-state-success-primary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      critical: "var(--dsw-alias-state-error-primary)",
      unknown: "var(--dsw-alias-state-idle-primary)",
    };

    function severityColor(severity) {
      return SEVERITY_COLOR[severity] || SEVERITY_COLOR.unknown;
    }

    function pctText(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "—";
      return (Math.round(value * 10) / 10).toString() + "%";
    }

    function formatCountdown(iso) {
      if (typeof iso !== "string" || iso === "") return "";
      const target = Date.parse(iso);
      if (!Number.isFinite(target)) return "";
      const diff = target - Date.now();
      if (diff <= 0) return "即将重置";
      const minutes = Math.round(diff / 60000);
      if (minutes < 60) return minutes + " 分钟后重置";
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return hours + " 小时 " + (minutes % 60) + " 分后重置";
      return Math.floor(hours / 24) + " 天后重置";
    }

    function formatLocal(iso) {
      if (typeof iso !== "string" || iso === "") return "";
      const time = Date.parse(iso);
      if (!Number.isFinite(time)) return "";
      const date = new Date(time);
      const pad = (n) => String(n).padStart(2, "0");
      return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    function providersOf(payload) {
      if (!payload || !Array.isArray(payload.providers)) return [];
      return payload.providers.filter((p) => p && typeof p === "object");
    }

    function configOf(payload, providerId) {
      const list = payload && payload.config && Array.isArray(payload.config.providers) ? payload.config.providers : [];
      return list.find((c) => c && c.id === providerId) || null;
    }

    function uiOf(providerId) {
      return PROVIDER_UI[providerId] || { id: providerId, label: providerId, labelShort: providerId, match: /.^/ };
    }

    /** 徽标与标题都从这份「最紧张窗口」视图取数。 */
    function worstView(snapshot) {
      if (!snapshot || snapshot.ok !== true) return null;
      const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
      if (windows.length === 0) return null;
      return windows.find((w) => w.id === snapshot.worstWindowId) || windows.reduce((acc, w) => {
        if (acc === null) return w;
        if (typeof w.usedPercent !== "number") return acc;
        if (typeof acc.usedPercent !== "number") return w;
        return w.usedPercent > acc.usedPercent ? w : acc;
      }, null);
    }

    /** extras 有两种形状：GLM 的搜索额度（used/total/remaining）与 MiniMax 的按模型剩余百分比。 */
    function extraLine(extra) {
      if (extra.used !== null && extra.used !== undefined) {
        return extra.title + "：" + String(extra.used) + " / " + String(extra.total) + "，剩 " + String(extra.remaining);
      }
      const parts = ["剩余 " + pctText(extra.remainingPercent)];
      if (typeof extra.weeklyRemainingPercent === "number") parts.push("每周剩 " + pctText(extra.weeklyRemainingPercent));
      return extra.title + "：" + parts.join("，");
    }

    function tooltipText(snapshot) {
      const ui = uiOf(snapshot && snapshot.provider);
      if (!snapshot) return ui.label + "：加载中…";
      if (snapshot.disabled) return ui.label + "：已在配置中停用";
      if (snapshot.ok !== true) return ui.label + "：" + String(snapshot.error || "查询失败");
      const lines = [];
      if (snapshot.plan && snapshot.plan.name) lines.push(snapshot.plan.name + (snapshot.level ? " · " + snapshot.level : ""));
      for (const window of snapshot.windows || []) {
        lines.push(window.title + "：已用 " + pctText(window.usedPercent) + "，剩余 " + pctText(window.remainingPercent));
        const reset = formatCountdown(window.resetAt);
        if (reset) lines.push("  " + reset + "（" + formatLocal(window.resetAt) + "）");
      }
      for (const extra of snapshot.extras || []) {
        lines.push(extraLine(extra));
      }
      lines.push("点击立即刷新");
      return lines.join("\n");
    }

    // ---- 样式（一次注入，跟随主题变量） ----

    const STYLE_ID = "dsh-glm-quota-style";
    const CSS = [
      ".glmq-badge{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 9px 2px 7px;font-size:11px;font-weight:600;line-height:18px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}",
      ".glmq-badge:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".glmq-badge[data-stale]{opacity:.6}",
      ".glmq-badge-rail{padding:0;width:26px;height:26px;justify-content:center;border-radius:8px}",
      ".glmq-badge-sep{width:1px;height:12px;background:var(--dsw-alias-border-l2);flex:none}",
      ".glmq-dot{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block}",
      ".glmq-dock{display:inline-flex;align-items:center;gap:8px;margin-left:auto;padding:2px 4px}",
      ".glmq-dock-pill{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 8px;font-size:11px;line-height:18px;cursor:pointer;transition:background .15s,color .15s;white-space:nowrap}",
      ".glmq-dock-pill:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".glmq-dock-pill strong{font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".glmq-panel{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px}",
      ".glmq-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      ".glmq-title{font-size:15px;font-weight:600;margin:0}",
      ".glmq-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px;line-height:1.6}",
      ".glmq-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}",
      ".glmq-group{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}",
      ".glmq-group-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}",
      ".glmq-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}",
      ".glmq-name{font-weight:600}",
      ".glmq-meta{color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".glmq-track{position:relative;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
      ".glmq-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;transition:width .3s ease}",
      ".glmq-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".glmq-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s}",
      ".glmq-btn:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".glmq-btn:disabled{opacity:.5;cursor:default}",
      ".glmq-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}",
      ".glmq-btn-primary:hover{opacity:.9;background:var(--dsw-alias-brand-primary)}",
      ".glmq-input{flex:1;min-width:180px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:7px;padding:6px 9px;font-size:12px;font-family:inherit}",
      ".glmq-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 8px;font-size:12px}",
      ".glmq-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6}",
      ".glmq-ok{color:var(--dsw-alias-state-success-primary)}",
      ".glmq-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}",
      ".glmq-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}",
      ".glmq-field{display:flex;flex-direction:column;gap:6px}",
      ".glmq-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
    ].join("\n");

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ---- 侧边栏徽标：每家 provider 一段 ----

    function QuotaBadge(ownerProps) {
      ensureStyle();
      const { payload, error, refreshing } = useQuota();
      const entries = providersOf(payload).filter((p) => p.disabled !== true);
      const compact = ownerProps !== null && typeof ownerProps === "object" && ownerProps.wide === false;
      const children = [];
      if (entries.length === 0) {
        children.push(react.createElement("span", { key: "state" }, refreshing ? "…" : "?"));
      }
      entries.forEach((snapshot, index) => {
        const ui = uiOf(snapshot.provider);
        const worst = worstView(snapshot);
        const failed = snapshot.ok !== true;
        const color = failed ? "var(--dsw-alias-state-idle-primary)" : severityColor(worst && worst.severity);
        const text = refreshing ? ui.labelShort + " …" : failed ? ui.labelShort + " ?" : worst ? ui.labelShort + " " + pctText(worst.usedPercent) : ui.labelShort;
        if (index > 0 && !compact) children.push(react.createElement("span", { key: "sep-" + snapshot.provider, className: "glmq-badge-sep" }));
        children.push(react.createElement("span", { key: "dot-" + snapshot.provider, className: "glmq-dot", style: { background: color } }));
        // 侧边栏收成 56px 导轨时只留彩点，完整信息仍在 tooltip 里。
        if (!compact) children.push(react.createElement("span", { key: "text-" + snapshot.provider }, text));
      });
      const title = entries.map((snapshot) => tooltipText(snapshot)).join("\n\n") + (error ? "\n错误：" + error : "");
      const props = {
        type: "button",
        className: compact ? "glmq-badge glmq-badge-rail" : "glmq-badge",
        title: title,
        "aria-label": title,
        onClick: () => void refreshNow(),
      };
      if (refreshing) props["data-stale"] = "true";
      return react.createElement("button", props, children);
    }

    // ---- 会话模型探测（dock 用） ----

    /** sessions 服务（wire 时注入），用来按 sessionId 读 modelSelection 投影。 */
    let sessionsService = null;

    function rememberSessions(candidate) {
      if (candidate && typeof candidate.binding === "function") {
        sessionsService = candidate;
        return true;
      }
      return false;
    }

    /** 从 modelSelection 快照项里提取 {provider, name}；项形如 {provider, model, reasoningEffort}。 */
    function modelFromSelection(sel) {
      if (!sel || typeof sel !== "object") return null;
      const provider = typeof sel.provider === "string" ? sel.provider : "";
      const name =
        typeof sel.model === "string" ? sel.model : typeof sel.name === "string" ? sel.name : "";
      if (!provider && !name) return null;
      return { provider: provider, name: name };
    }

    /** 从 modelSelection 投影里取当前选择：next（已切未发送）优先，lastUsed 兜底。 */
    function faceSelection(face) {
      try {
        const snap = face && typeof face.getSnapshot === "function" ? face.getSnapshot() : null;
        if (!snap || typeof snap !== "object") return null;
        return modelFromSelection(snap.next) || modelFromSelection(snap.lastUsed);
      } catch (_) {
        return null;
      }
    }

    /**
     * 多源探测当前会话模型。composer dock 传入的 session 是快照（有 sessionId/running 等，
     * 没有 model），真值在 sessions.binding(sessionId).session.projections.faceOf("modelSelection")。
     * 返回 {provider, name, face} 或 null；face 供订阅模型切换。
     */
    function detectModel(ownerProps) {
      const session =
        ownerProps && typeof ownerProps === "object" && ownerProps.session && typeof ownerProps.session === "object"
          ? ownerProps.session
          : null;
      // ① 宿主直接给了带 projections 的活对象
      let face = null;
      try {
        face =
          session && session.projections && typeof session.projections.faceOf === "function"
            ? session.projections.faceOf("modelSelection")
            : null;
      } catch (_) {
        face = null;
      }
      if (face) {
        const m = faceSelection(face);
        if (m) return { provider: m.provider, name: m.name, face: face };
      }
      // ② sessions 服务按 sessionId 取投影（正路）
      const sessionId =
        ownerProps && typeof ownerProps.sessionId === "string"
          ? ownerProps.sessionId
          : session && typeof session.sessionId === "string"
            ? session.sessionId
            : null;
      if (sessionsService && sessionId) {
        try {
          const binding = sessionsService.binding(sessionId);
          face =
            binding && binding.session && binding.session.projections && typeof binding.session.projections.faceOf === "function"
              ? binding.session.projections.faceOf("modelSelection")
              : null;
          if (face) {
            const m = faceSelection(face);
            if (m) return { provider: m.provider, name: m.name, face: face };
          }
        } catch (_) {
          // binding 可能还没就绪，走兜底
        }
      }
      // ③ 快照直读（万一以后宿主把 model 放进 zone.session）
      const direct =
        modelFromSelection(session ? session.model : null) ||
        (function () {
          const ms = session ? session.modelSelection : null;
          if (!ms || typeof ms !== "object") return null;
          return modelFromSelection(ms.next) || modelFromSelection(ms.lastUsed);
        })();
      if (direct) return { provider: direct.provider, name: direct.name, face: null };
      return null;
    }

    /** 当前模型命中的 provider 列表（GLM 模型 → ['glm']，MiniMax 模型 → ['minimax']）。 */
    function matchedProviders(detected) {
      if (!detected) return [];
      const hay = (detected.provider || "") + " " + (detected.name || "");
      return Object.keys(PROVIDER_UI).filter((id) => {
        try {
          return PROVIDER_UI[id].match.test(hay);
        } catch (_) {
          return false;
        }
      });
    }

    /**
     * 聊天窗口输入框下方的额度条：仅当本会话切到已支持的模型时出现。
     * ownerProps 由 composer dock 的宿主传入：{ session, input }。
     */
    function QuotaDock(ownerProps) {
      // 注意：hooks 必须无条件调用（早退会导致 hook 数量在模型切换时变化，React 会报错）。
      const detected = detectModel(ownerProps);
      const face = detected ? detected.face : null;
      const [, setModelTick] = react.useState(0);
      react.useEffect(
        function () {
          if (!face || typeof face.subscribe !== "function") return undefined;
          let alive = true;
          const dispose = face.subscribe(function () {
            if (alive) setModelTick(function (n) { return n + 1; });
          });
          return function () {
            alive = false;
            if (typeof dispose === "function") dispose();
          };
        },
        [face],
      );
      const { payload, error, refreshing } = useQuota();
      const matched = matchedProviders(detected);
      if (matched.length === 0) return null;
      ensureStyle();
      const pills = [];
      for (const providerId of matched) {
        const ui = uiOf(providerId);
        const snapshot = providersOf(payload).find((p) => p.provider === providerId && p.disabled !== true) || null;
        const title = tooltipText(snapshot) + (error ? "\n错误：" + error : "");
        const windows = snapshot && snapshot.ok === true && Array.isArray(snapshot.windows) ? snapshot.windows : [];
        if (windows.length === 0) {
          const loading = refreshing || payload === null || payload === undefined;
          pills.push(
            react.createElement(
              "span",
              { key: providerId + "-state", className: "glmq-dock-pill", title: title, onClick: () => void refreshNow() },
              loading ? ui.labelShort + " …" : ui.labelShort + " ?",
            ),
          );
          continue;
        }
        for (const window of windows) {
          pills.push(
            react.createElement(
              "span",
              {
                key: providerId + "-" + window.id,
                className: "glmq-dock-pill",
                title: ui.label + " · " + window.title + "：已用 " + pctText(window.usedPercent) + "\n" + title,
                onClick: () => void refreshNow(),
              },
              react.createElement("span", { className: "glmq-dot", style: { background: severityColor(window.severity) } }),
              react.createElement("span", null, ui.labelShort + " ", window.shortTitle || window.title, " "),
              react.createElement("strong", null, pctText(window.usedPercent)),
            ),
          );
        }
      }
      return react.createElement("span", { className: "glmq-dock" }, pills);
    }

    // ---- 进度条 ----

    function Bar({ percent, severity }) {
      const width = typeof percent === "number" && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
      return react.createElement(
        "div",
        { className: "glmq-track" },
        react.createElement("div", { className: "glmq-fill", style: { width: width + "%", background: severityColor(severity) } }),
      );
    }

    // ---- 设置页 ----

    function WindowCard({ window }) {
      return react.createElement(
        "div",
        { className: "glmq-card" },
        react.createElement(
          "div",
          { className: "glmq-row" },
          react.createElement("span", { className: "glmq-name" }, window.title),
          react.createElement(
            "span",
            { className: "glmq-meta" },
            "已用 ",
            react.createElement("strong", { style: { color: severityColor(window.severity) } }, pctText(window.usedPercent)),
            " · 剩余 ",
            pctText(window.remainingPercent),
          ),
        ),
        react.createElement(Bar, { percent: window.usedPercent, severity: window.severity }),
        react.createElement(
          "div",
          { className: "glmq-meta" },
          [formatCountdown(window.resetAt), formatLocal(window.resetAt)].filter(Boolean).join(" · ") || "重置时间未知",
        ),
      );
    }

    /** extras 两形状：GLM 搜索额度（used/total）与 MiniMax 按模型剩余（remainingPercent）。 */
    function ExtraCard({ extra }) {
      const hasCounts = extra.used !== null && extra.used !== undefined;
      if (!hasCounts) {
        const parts = ["5 小时窗口剩余 ", react.createElement("strong", { style: { color: severityColor(extra.usedPercent === null ? "unknown" : extra.usedPercent >= 90 ? "critical" : extra.usedPercent >= 70 ? "warn" : "ok") } }, pctText(extra.remainingPercent))];
        if (typeof extra.weeklyRemainingPercent === "number") {
          parts.push(" · 每周剩余 ", react.createElement("strong", null, pctText(extra.weeklyRemainingPercent)));
        }
        return react.createElement(
          "div",
          { className: "glmq-card" },
          react.createElement("div", { className: "glmq-row" }, react.createElement("span", { className: "glmq-name" }, extra.title), react.createElement("span", { className: "glmq-meta" }, parts)),
        );
      }
      return react.createElement(
        "div",
        { className: "glmq-card" },
        react.createElement(
          "div",
          { className: "glmq-row" },
          react.createElement("span", { className: "glmq-name" }, extra.title),
          react.createElement(
            "span",
            { className: "glmq-meta" },
            String(extra.used ?? "?") + " / " + String(extra.total ?? "?"),
            extra.remaining !== null && extra.remaining !== undefined ? " · 剩 " + String(extra.remaining) : "",
          ),
        ),
        react.createElement(Bar, { percent: extra.usedPercent, severity: "ok" }),
        react.createElement("div", { className: "glmq-meta" }, formatLocal(extra.resetAt) + " 重置"),
      );
    }

    function SettingsPanel() {
      ensureStyle();
      const { payload, error, refreshing } = useQuota();
      const [keyInputs, setKeyInputs] = react.useState({});
      const [busy, setBusy] = react.useState(false);
      const [notice, setNotice] = react.useState(null);
      const [keyEditors, setKeyEditors] = react.useState({});

      const config = payload && payload.config ? payload.config : null;

      const act = (patch, okText) => {
        setBusy(true);
        setNotice(null);
        saveConfig(patch)
          .then(() => {
            setNotice({ kind: "ok", text: okText });
          })
          .catch((cause) => {
            setNotice({ kind: "err", text: cause instanceof Error ? cause.message : String(cause) });
          })
          .finally(() => setBusy(false));
      };

      const saveKey = (providerId) => {
        const value = (keyInputs[providerId] || "").trim();
        if (value === "") return;
        act({ provider: providerId, apiKey: value }, "API Key 已保存");
        setKeyInputs((s) => Object.assign({}, s, { [providerId]: "" }));
      };

      const clearKey = (providerId) => {
        act({ provider: providerId, apiKey: "" }, "已清除保存的 API Key");
      };

      const intervalSelect = react.createElement(
        "select",
        {
          className: "glmq-select",
          value: config ? String(config.intervalSeconds) : "120",
          disabled: busy || !config,
          onChange: (event) => act({ intervalSeconds: Number(event.target.value) }, "刷新间隔已更新"),
        },
        [60, 120, 300, 600, 1800].map((seconds) =>
          react.createElement("option", { key: seconds, value: String(seconds) }, seconds < 60 ? seconds + " 秒" : seconds / 60 + " 分钟"),
        ),
      );

      // 每家 provider 一组卡片
      const groups = providersOf(payload).map((snapshot) => {
        const providerId = snapshot.provider;
        const ui = uiOf(providerId);
        const cfg = configOf(payload, providerId);
        const key = snapshot.key || null;
        const editing = keyEditors[providerId] === true || (key !== null && !key.configured);

        const regionSelect = react.createElement(
          "select",
          {
            className: "glmq-select",
            value: cfg ? cfg.region : snapshot.region,
            disabled: busy || !cfg,
            onChange: (event) => act({ provider: providerId, region: event.target.value }, ui.label + " 区域已切换"),
          },
          (cfg && cfg.regionOptions ? cfg.regionOptions : [{ value: snapshot.region, label: snapshot.regionLabel }]).map((option) =>
            react.createElement("option", { key: option.value, value: option.value }, option.label),
          ),
        );

        const statusLine = (() => {
          if (snapshot.disabled) return react.createElement("div", { className: "glmq-hint" }, "这家 provider 已停用，徽标与胶囊不再显示它的数据。");
          if (snapshot.ok !== true) {
            return react.createElement(
              "div",
              { className: "glmq-err" },
              String(snapshot.error || "查询失败"),
              snapshot.needsKey ? react.createElement("div", { className: "glmq-hint", style: { marginTop: "6px" } }, "填入 Key 或在「设置 → 模型」里配好对应提供商后会自动恢复。") : null,
            );
          }
          return react.createElement(
            "div",
            { className: "glmq-hint" },
            "上次查询 " + formatLocal(new Date(snapshot.fetchedAt).toISOString()) + (refreshing ? " · 刷新中…" : ""),
          );
        })();

        const planLine = (() => {
          if (snapshot.disabled || snapshot.ok !== true || snapshot.plan === null) return null;
          const plan = snapshot.plan;
          const bits = [];
          if (plan.status) bits.push(plan.status === "VALID" ? "生效中" : plan.status);
          if (plan.autoRenew) bits.push("自动续费");
          if (plan.nextRenewTime) bits.push("下次续费 " + plan.nextRenewTime);
          if (snapshot.level) bits.push("等级 " + snapshot.level);
          return react.createElement(
            "div",
            { className: "glmq-card" },
            react.createElement(
              "div",
              { className: "glmq-row" },
              react.createElement("span", { className: "glmq-name" }, plan.name || plan.bigTitle || ui.label + " Coding Plan"),
              react.createElement("span", { className: "glmq-meta" }, bits.join(" · ")),
            ),
          );
        })();

        const windowCards = (snapshot.ok === true && snapshot.windows ? snapshot.windows : []).map((window) =>
          react.createElement(WindowCard, { key: providerId + "-w-" + window.id, window }),
        );
        const extraCards = (snapshot.ok === true && snapshot.extras ? snapshot.extras : []).map((extra) =>
          react.createElement(ExtraCard, { key: providerId + "-e-" + extra.id, extra }),
        );

        const keyCard = react.createElement(
          "div",
          { className: "glmq-card" },
          react.createElement("div", { className: "glmq-label" }, ui.label + " 的 API Key"),
          react.createElement(
            "div",
            { className: "glmq-hint" },
            key !== null && key.configured
              ? react.createElement(
                  "span",
                  null,
                  react.createElement("span", { className: "glmq-ok" }, "✓ 已自动复用凭证 "),
                  react.createElement("span", { className: "glmq-code" }, key.ref || (cfg ? cfg.keyRef : "")),
                  key.source ? "（来源 " + key.source + "）" : "",
                  "，与模型配置共享，无需重复填写。",
                )
              : react.createElement(
                  "span",
                  null,
                  react.createElement("span", { className: "glmq-err" }, "未找到可用 Key"),
                  "：请先在「设置 → 模型」里配置 " + ui.label + " 提供商（推荐，Key 会自动共享），或在下面手动填一个。",
                ),
          ),
          key !== null && key.configured && !editing
            ? react.createElement(
                "div",
                { className: "glmq-actions" },
                react.createElement(
                  "button",
                  { type: "button", className: "glmq-btn", disabled: busy, onClick: () => setKeyEditors((s) => Object.assign({}, s, { [providerId]: true })) },
                  "使用其他 Key…",
                ),
              )
            : react.createElement(
                "div",
                { className: "glmq-actions" },
                react.createElement("input", {
                  className: "glmq-input",
                  type: "password",
                  placeholder: key !== null && key.configured ? "输入要覆盖使用的 API Key" : "粘贴 API Key",
                  value: keyInputs[providerId] || "",
                  disabled: busy,
                  onChange: (event) => setKeyInputs((s) => Object.assign({}, s, { [providerId]: event.target.value })),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") saveKey(providerId);
                  },
                }),
                react.createElement("button", { type: "button", className: "glmq-btn", disabled: busy || (keyInputs[providerId] || "").trim() === "", onClick: () => saveKey(providerId) }, "保存"),
                key !== null && key.configured
                  ? react.createElement("button", { type: "button", className: "glmq-btn", disabled: busy, onClick: () => { setKeyEditors((s) => Object.assign({}, s, { [providerId]: false })); setKeyInputs((s) => Object.assign({}, s, { [providerId]: "" })); } }, "取消")
                  : react.createElement("button", { type: "button", className: "glmq-btn", disabled: busy || key === null || !key.configured, onClick: () => clearKey(providerId) }, "清除"),
              ),
          react.createElement(
            "div",
            { className: "glmq-hint" },
            providerId === "minimax"
              ? "默认读取凭证 " + react.createElement("span", { className: "glmq-code" }, cfg ? cfg.keyRef : "MINIMAX_CN_API_KEY") + "（国内版）或 MINIMAX_API_KEY（国际版）。注意：用量查询必须使用 Token Plan 订阅 Key，普通按量付费 API Key 查不了。"
              : "默认读取凭证 " + react.createElement("span", { className: "glmq-code" }, cfg ? cfg.keyRef : "ZAI_CODING_CN_API_KEY") + "（模型配置里存的就是它）。国内版走 bigmodel.cn，国际版走 z.ai。",
          ),
        );

        return react.createElement(
          "div",
          { key: providerId, className: "glmq-group" },
          react.createElement(
            "div",
            { className: "glmq-group-head" },
            react.createElement(
              "div",
              { className: "glmq-actions" },
              react.createElement("span", { className: "glmq-name" }, ui.label + " 额度"),
              react.createElement("span", { className: "glmq-meta" }, cfg ? cfg.regionLabel : snapshot.regionLabel),
            ),
            react.createElement(
              "div",
              { className: "glmq-actions" },
              react.createElement("span", { className: "glmq-meta" }, "区域"),
              regionSelect,
              cfg
                ? react.createElement(
                    "button",
                    { type: "button", className: "glmq-btn", disabled: busy, onClick: () => act({ provider: providerId, providerEnabled: !(cfg && cfg.enabled !== false) }, cfg && cfg.enabled !== false ? ui.label + " 已停用" : ui.label + " 已启用") },
                    cfg && cfg.enabled !== false ? "停用" : "启用",
                  )
                : null,
            ),
          ),
          statusLine,
          planLine,
          windowCards,
          extraCards,
          keyCard,
        );
      });

      return react.createElement(
        "div",
        { className: "glmq-panel" },
        react.createElement(
          "div",
          { className: "glmq-head" },
          react.createElement(
            "div",
            null,
            react.createElement("h2", { className: "glmq-title" }, "额度监控"),
            react.createElement(
              "div",
              { className: "glmq-sub" },
              "监控 GLM Coding Plan 与 MiniMax Token Plan 的额度窗口。查询在宿主端完成，自动复用「设置 → 模型」里配好的 Key；切到对应模型的会话里，输入框下方会出现额度胶囊。",
            ),
          ),
          react.createElement(
            "div",
            { className: "glmq-actions" },
            react.createElement(
              "button",
              { type: "button", className: "glmq-btn glmq-btn-primary", disabled: refreshing, onClick: () => void refreshNow() },
              refreshing ? "刷新中…" : "立即刷新",
            ),
          ),
        ),
        groups.length > 0
          ? groups
          : react.createElement("div", { className: "glmq-hint" }, payload === null ? "加载中…" : "宿主端没有返回任何 provider。"),
        react.createElement(
          "div",
          { className: "glmq-card" },
          react.createElement("div", { className: "glmq-label" }, "查询设置"),
          react.createElement(
            "div",
            { className: "glmq-actions" },
            react.createElement("span", { className: "glmq-meta" }, "刷新间隔"),
            intervalSelect,
          ),
          react.createElement("div", { className: "glmq-hint" }, "宿主端按此间隔后台轮询并缓存；界面端每 30 秒读一次缓存，点击徽标或「立即刷新」会强制重查。"),
        ),
        notice !== null
          ? react.createElement("div", { className: notice.kind === "err" ? "glmq-err" : "glmq-ok" }, notice.text)
          : null,
        error !== null && error !== undefined ? react.createElement("div", { className: "glmq-err" }, String(error)) : null,
      );
    }

    // ---- 挂载 ----

    function apply(ctx) {
      const wire = (ready) => {
        const register = () => {
          ready.slots.inject("sidebar.footer.action", () =>
            ready.slots.register(
              {
                name: "sidebar.footer.action",
                id: "dsh-glm-quota-badge",
                order: 45,
                label: () => "额度监控",
              },
              (ownerProps) => react.createElement(QuotaBadge, ownerProps || null),
            ),
          );
          ready.slots.inject("conversation.composer.dock", () =>
            ready.slots.register(
              {
                name: "conversation.composer.dock",
                id: "dsh-glm-quota-dock",
                order: 50,
                label: () => "额度胶囊",
              },
              (ownerProps) => react.createElement(QuotaDock, ownerProps),
            ),
          );
          ready.slots.inject("settings.section", () =>
            ready.slots.register(
              {
                name: "settings.section",
                id: "glm-quota",
                order: 60,
                label: () => "额度监控",
              },
              () => react.createElement(SettingsPanel, null),
            ),
          );
        };
        if (typeof ready.effect === "function") ready.effect(register, "dsh-glm-quota: mounts");
        else register();
      };

      if (typeof ctx.inject === "function") {
        // sessions 服务用于按 sessionId 读取 modelSelection 投影（dock 模型探测的真值来源）。
        // 独立注入、失败不致命：拿不到时 detectModel 走 ownerProps 兜底路径。
        try {
          ctx.inject(["sessions"], (ready) => {
            rememberSessions(ready && ready.sessions ? ready.sessions : ready);
          });
        } catch (_) {
          // 某些宿主不支持额外注入，忽略
        }
        try {
          if (typeof ctx.get === "function") rememberSessions(ctx.get("sessions"));
        } catch (_) {
          // 服务可能尚未就绪，忽略
        }
        ctx.inject(["slots"], wire);
        return;
      }
      if (ctx.slots !== undefined) {
        if (ctx.sessions !== undefined) rememberSessions(ctx.sessions);
        try {
          if (typeof ctx.get === "function") rememberSessions(ctx.get("sessions"));
        } catch (_) {
          // 忽略
        }
        wire(ctx);
      }
    }

    exports.apply = apply;
    return module.exports;
  },
});
