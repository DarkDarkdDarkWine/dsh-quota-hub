/**
 * dsh-glm-quota — 界面端。
 *
 * 手写 wrapper，不经构建：DSH 用 window.__ModuleLoader__ 加载它，
 * require("react") 由宿主提供。这里只做两件事：
 *
 *   1. sidebar.footer.action  — 侧边栏底部一枚百分比徽标（点一下 = 立即刷新）
 *   2. settings.section       — 「GLM 额度」设置页：窗口进度、重置时间、Key 与刷新间隔
 *
 * 数据全部来自宿主端 /dsh-glm-quota/*.json，界面端不直接访问外网，
 * 也不持有 Key。
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

    async function loadOnce() {
      try {
        const res = await fetch(BASE + "/status.json", { headers: { accept: "application/json" }, cache: "no-store" });
        const payload = await res.json();
        const failed = payload !== null && typeof payload === "object" && payload.ok === false;
        emit({ loading: false, payload, error: failed ? String(payload.error) : null });
      } catch (cause) {
        emit({ loading: false, error: "无法连接宿主端：" + String(cause) });
      }
    }

    async function refreshNow() {
      if (store.state.refreshing) return;
      emit({ refreshing: true });
      try {
        const res = await fetch(BASE + "/refresh.json", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const payload = await res.json();
        emit({ loading: false, refreshing: false, payload, error: payload && payload.ok === false ? String(payload.error) : null });
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
      emit({ loading: false, payload, error: payload.snapshot && payload.snapshot.ok === false ? String(payload.snapshot.error) : null });
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

    function tooltipText(snapshot) {
      if (!snapshot) return "GLM 额度：加载中…";
      if (snapshot.ok !== true) return "GLM 额度：" + String(snapshot.error || "查询失败");
      const lines = [];
      if (snapshot.plan && snapshot.plan.name) lines.push(snapshot.plan.name + (snapshot.level ? " · " + snapshot.level : ""));
      for (const window of snapshot.windows || []) {
        lines.push(window.title + "：已用 " + pctText(window.usedPercent) + "，剩余 " + pctText(window.remainingPercent));
        const reset = formatCountdown(window.resetAt);
        if (reset) lines.push("  " + reset + "（" + formatLocal(window.resetAt) + "）");
      }
      for (const extra of snapshot.extras || []) {
        lines.push(extra.title + "：" + String(extra.used) + " / " + String(extra.total) + "，剩 " + String(extra.remaining));
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

    // ---- 侧边栏徽标 ----

    function QuotaBadge(ownerProps) {
      ensureStyle();
      const { payload, error, refreshing } = useQuota();
      const snapshot = payload && payload.snapshot ? payload.snapshot : null;
      const worst = worstView(snapshot);
      const failed = snapshot === null || snapshot.ok !== true;
      const color = failed ? "var(--dsw-alias-state-idle-primary)" : severityColor(worst && worst.severity);
      const compact = ownerProps !== null && typeof ownerProps === "object" && ownerProps.wide === false;
      const text = refreshing ? "GLM …" : failed ? "GLM ?" : worst ? "GLM " + pctText(worst.usedPercent) : "GLM";
      const title = tooltipText(snapshot) + (error ? "\n错误：" + error : "");
      const props = {
        type: "button",
        className: compact ? "glmq-badge glmq-badge-rail" : "glmq-badge",
        title: title,
        "aria-label": title,
        onClick: () => void refreshNow(),
      };
      if (refreshing) props["data-stale"] = "true";
      const children = [react.createElement("span", { key: "dot", className: "glmq-dot", style: { background: color } })];
      // 侧边栏收成 56px 导轨时只留一个彩点，完整信息仍在 tooltip 里。
      if (!compact) children.push(react.createElement("span", { key: "text" }, text));
      return react.createElement("button", props, children);
    }

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

    function isGlm(detected) {
      return !!detected && /zai|bigmodel|glm/i.test(detected.provider + " " + detected.name);
    }

    /**
     * 聊天窗口输入框下方的额度条：仅当本会话切到 GLM 模型时出现。
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
      if (!isGlm(detected)) return null;
      ensureStyle();
      const snapshot = payload && payload.snapshot ? payload.snapshot : null;
      const title = tooltipText(snapshot) + (error ? "\n错误：" + error : "");
      const windows = snapshot && snapshot.ok === true && Array.isArray(snapshot.windows) ? snapshot.windows : [];
      const pills = [];
      if (windows.length === 0) {
        const loading = refreshing || payload === null || payload === undefined;
        pills.push(
          react.createElement(
            "span",
            { key: "state", className: "glmq-dock-pill", title: title, onClick: () => void refreshNow() },
            loading ? "GLM …" : "GLM ?",
          ),
        );
      } else {
        for (const window of windows) {
          pills.push(
            react.createElement(
              "span",
              {
                key: window.id,
                className: "glmq-dock-pill",
                title: window.title + "：已用 " + pctText(window.usedPercent) + "\n" + title,
                onClick: () => void refreshNow(),
              },
              react.createElement("span", { className: "glmq-dot", style: { background: severityColor(window.severity) } }),
              react.createElement("span", null, window.shortTitle || window.title, " "),
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

    function ExtraCard({ extra }) {
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
      const [keyInput, setKeyInput] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [notice, setNotice] = react.useState(null);
      const [showKeyEditor, setShowKeyEditor] = react.useState(false);

      const config = payload && payload.config ? payload.config : null;
      const key = payload && payload.key ? payload.key : null;
      const snapshot = payload && payload.snapshot ? payload.snapshot : null;

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

      const saveKey = () => {
        const value = keyInput.trim();
        if (value === "") return;
        act({ apiKey: value }, "API Key 已保存");
        setKeyInput("");
      };

      const clearKey = () => {
        act({ apiKey: "" }, "已清除保存的 API Key");
      };

      const regionSelect = react.createElement(
        "select",
        {
          className: "glmq-select",
          value: config ? config.region : "cn",
          disabled: busy || !config,
          onChange: (event) => act({ region: event.target.value }, "已切换区域"),
        },
        (config && config.regionOptions ? config.regionOptions : [{ value: "cn", label: "国内版 bigmodel.cn" }, { value: "global", label: "国际版 z.ai" }]).map((option) =>
          react.createElement("option", { key: option.value, value: option.value }, option.label),
        ),
      );

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

      const statusLine = (() => {
        if (snapshot === null) return react.createElement("div", { className: "glmq-hint" }, "加载中…");
        if (snapshot.ok !== true) {
          return react.createElement(
            "div",
            { className: "glmq-err" },
            String(snapshot.error || "查询失败"),
            snapshot.needsKey ? react.createElement("div", { className: "glmq-hint", style: { marginTop: "6px" } }, "填入 Key 后会自动恢复。") : null,
          );
        }
        return react.createElement(
          "div",
          { className: "glmq-hint" },
          "上次查询 " + formatLocal(new Date(snapshot.fetchedAt).toISOString()) + (refreshing ? " · 刷新中…" : ""),
        );
      })();

      const planLine = (() => {
        if (snapshot === null || snapshot.ok !== true || snapshot.plan === null) return null;
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
            react.createElement("span", { className: "glmq-name" }, plan.name || plan.bigTitle || "GLM Coding Plan"),
            react.createElement("span", { className: "glmq-meta" }, bits.join(" · ")),
          ),
        );
      })();

      return react.createElement(
        "div",
        { className: "glmq-panel" },
        react.createElement(
          "div",
          { className: "glmq-head" },
          react.createElement(
            "div",
            null,
            react.createElement("h2", { className: "glmq-title" }, "GLM 额度"),
            react.createElement(
              "div",
              { className: "glmq-sub" },
              "监控 GLM Coding Plan 的 5 小时窗口与每周窗口。数据来自智谱监控接口，查询在宿主端完成，Key 不会发给界面。",
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
        statusLine,
        planLine,
        (snapshot && snapshot.ok === true && snapshot.windows ? snapshot.windows : []).map((window) =>
          react.createElement(WindowCard, { key: window.id, window }),
        ),
        (snapshot && snapshot.ok === true && snapshot.extras ? snapshot.extras : []).map((extra) =>
          react.createElement(ExtraCard, { key: extra.id, extra }),
        ),
        react.createElement(
          "div",
          { className: "glmq-card" },
          react.createElement("div", { className: "glmq-label" }, "API Key"),
          react.createElement(
            "div",
            { className: "glmq-hint" },
            key !== null && key.configured
              ? react.createElement(
                  "span",
                  null,
                  react.createElement("span", { className: "glmq-ok" }, "✓ 已自动复用凭证 "),
                  react.createElement("span", { className: "glmq-code" }, key.ref || (config ? config.keyRef : "ZAI_CODING_CN_API_KEY")),
                  key.source ? "（来源 " + key.source + "）" : "",
                  "，与模型配置共享，无需重复填写。",
                )
              : react.createElement(
                  "span",
                  null,
                  react.createElement("span", { className: "glmq-err" }, "未找到可用 Key"),
                  "：请先在「设置 → 模型」里配置 GLM 提供商（推荐，Key 会自动共享），或在下面手动填一个。",
                ),
          ),
          key !== null && key.configured && !showKeyEditor
            ? react.createElement(
                "div",
                { className: "glmq-actions" },
                react.createElement(
                  "button",
                  { type: "button", className: "glmq-btn", disabled: busy, onClick: () => setShowKeyEditor(true) },
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
                  value: keyInput,
                  disabled: busy,
                  onChange: (event) => setKeyInput(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === "Enter") saveKey();
                  },
                }),
                react.createElement("button", { type: "button", className: "glmq-btn", disabled: busy || keyInput.trim() === "", onClick: saveKey }, "保存"),
                key !== null && key.configured
                  ? react.createElement("button", { type: "button", className: "glmq-btn", disabled: busy, onClick: () => { setShowKeyEditor(false); setKeyInput(""); } }, "取消")
                  : react.createElement("button", { type: "button", className: "glmq-btn", disabled: busy || key === null || !key.configured, onClick: clearKey }, "清除"),
              ),
          react.createElement(
            "div",
            { className: "glmq-hint" },
            "默认读取凭证 ",
            react.createElement("span", { className: "glmq-code" }, config ? config.keyRef : "ZAI_CODING_CN_API_KEY"),
            "（模型配置里存的就是它）。国内版到 bigmodel.cn 取 Key，国际版到 z.ai 取 Key。",
          ),
        ),
        react.createElement(
          "div",
          { className: "glmq-card" },
          react.createElement("div", { className: "glmq-label" }, "查询设置"),
          react.createElement(
            "div",
            { className: "glmq-actions" },
            react.createElement("span", { className: "glmq-meta" }, "区域"),
            regionSelect,
            react.createElement("span", { className: "glmq-meta", style: { marginLeft: "12px" } }, "刷新间隔"),
            intervalSelect,
          ),
          config ? react.createElement("div", { className: "glmq-hint" }, "当前接口：" + String(snapshot && snapshot.host ? snapshot.host : "—")) : null,
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
                label: () => "GLM 额度",
              },
              () => react.createElement(QuotaBadge, null),
            ),
          );
          ready.slots.inject("conversation.composer.dock", () =>
            ready.slots.register(
              {
                name: "conversation.composer.dock",
                id: "dsh-glm-quota-dock",
                order: 50,
                label: () => "GLM 额度",
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
                label: () => "GLM 额度",
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
