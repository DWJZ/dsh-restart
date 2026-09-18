/**
 * dsh-restart — browser half (lazy-CJS 客户端 bundle)。
 *
 * 在设置面板注册一个「重启」页:显示当前宿主进程的标识,并提供一键重启按钮。
 * 点击后 POST `/dsh-restart/restart`,宿主在 400ms 内退出、由 detached helper
 * 拉起同一启动命令的新进程;这里轮询 `/dsh-restart/status`,一旦 boot id 变化
 * 就刷新页面,让浏览器接到新宿主。
 */
window.__ModuleLoader__.load({
	id: "dsh-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region styles
		const CSS_ID = "dsh-restart/styles.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-restart";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".dshr_root{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;max-width:640px}",
				".dshr_card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.22));border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1,transparent)}",
				".dshr_title{font-weight:600;font-size:14px}",
				".dshr_desc{color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
				".dshr_grid{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:12px;font-variant-numeric:tabular-nums}",
				".dshr_key{color:var(--dsw-alias-label-tertiary)}",
				".dshr_val{color:var(--dsw-alias-label-secondary);word-break:break-all}",
				".dshr_actions{display:flex;align-items:center;gap:12px}",
				".dshr_state{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
				".dshr_state_busy{color:var(--dsw-alias-brand-primary,#3b82f6)}",
				".dshr_state_error{color:var(--dsw-alias-state-error-primary,#ef4444)}",
				".dshr_spinner{display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:50%;border:2px solid var(--dsw-alias-brand-primary,#3b82f6);border-top-color:transparent;animation:dshr-spin .7s linear infinite;vertical-align:-1px}",
				"@keyframes dshr-spin{to{transform:rotate(360deg)}}"
			].join("");
			document.head.appendChild(tag);
		}
		//#endregion

		//#region locale
		const NS = "dshRestart";
		const zh = {
			nav: "重启",
			title: "重启 DeepSeek Harness 宿主",
			desc: "重启会结束当前宿主进程,并由完全相同的启动命令拉起一个新进程。会话记录保存在磁盘上,重启后仍然在;已安装但尚未生效的插件会在重启后加载。\n重启期间页面会短暂断开,新宿主就绪后本页会自动刷新。",
			pid: "进程 PID",
			startedAt: "启动时间",
			uptime: "已运行",
			port: "端口",
			now: "立即重启 DSH",
			restarting: "正在重启…",
			waiting: "等待新宿主就绪({seconds}s)",
			restartFailed: "重启失败:{message}",
			statusFailed: "无法读取宿主状态:{message}",
			timeout: "等待新宿主就绪超时(60s)。请在启动 dsh 的终端里确认它是否已经退出。",
			unknown: "未知"
		};
		const en = {
			nav: "Restart",
			title: "Restart the DeepSeek Harness host",
			desc: "A restart ends the current host process and starts a new one with exactly the same launch command. Sessions live on disk and survive it; installed plugins that are not active yet load on the next boot.\nThe page disconnects briefly and reloads itself once the new host is up.",
			pid: "Process PID",
			startedAt: "Started at",
			uptime: "Uptime",
			port: "Port",
			now: "Restart DSH now",
			restarting: "Restarting…",
			waiting: "Waiting for the new host ({seconds}s)",
			restartFailed: "Restart failed: {message}",
			statusFailed: "Could not read host status: {message}",
			timeout: "Timed out after 60s waiting for the new host. Check the terminal that launched dsh whether it exited.",
			unknown: "unknown"
		};
		//#endregion

		/** 等待毫秒数。 */
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		/** 把毫秒数格式化成 `1h 02m 03s`。 */
		function formatDuration(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
			const total = Math.floor(ms / 1000);
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			const pad = (value) => String(value).padStart(2, "0");
			return hours > 0
				? hours + "h " + pad(minutes) + "m " + pad(seconds) + "s"
				: minutes > 0 ? minutes + "m " + pad(seconds) + "s" : seconds + "s";
		}

		/** 读一次宿主状态;失败返回 null(重启窗口内属于正常情况)。 */
		async function readStatus() {
			try {
				const response = await fetch("/dsh-restart/status", {
					cache: "no-store",
					headers: { accept: "application/json" }
				});
				if (!response.ok) return null;
				const data = await response.json();
				return data && typeof data.boot === "string" ? data : null;
			} catch {
				return null;
			}
		}

		/**
		 * 设置面板里的「重启」页。
		 * @param props.t - 由 `locale: NS` 注入的翻译函数。
		 */
		function RestartSection({ t }) {
			const [info, setInfo] = React.useState(null);
			const [statusError, setStatusError] = React.useState(null);
			const [phase, setPhase] = React.useState("idle");
			const [error, setError] = React.useState(null);
			const [elapsed, setElapsed] = React.useState(0);
			const [tick, setTick] = React.useState(0);

			// 打开页面时读一次宿主标识,并每秒刷新一次运行时长。
			React.useEffect(() => {
				let cancelled = false;
				const load = async () => {
					const status = await readStatus();
					if (cancelled) return;
					if (status === null) setStatusError(t("unknown"));
					else { setInfo(status); setStatusError(null); }
				};
				void load();
				const timer = setInterval(() => { setTick((value) => value + 1); }, 1000);
				return () => { cancelled = true; clearInterval(timer); };
			}, [t]);

			// 重启进行中的秒表。
			React.useEffect(() => {
				if (phase !== "restarting") return undefined;
				const startedAt = Date.now();
				const timer = setInterval(() => { setElapsed(Math.floor((Date.now() - startedAt) / 1000)); }, 1000);
				return () => clearInterval(timer);
			}, [phase]);

			const doRestart = React.useCallback(async () => {
				setPhase("restarting");
				setError(null);
				setElapsed(0);
				const previousBoot = info === null ? null : info.boot;
				try {
					const response = await fetch("/dsh-restart/restart", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}"
					});
					if (!response.ok) throw new Error("HTTP " + String(response.status));
				} catch (cause) {
					setPhase("failed");
					setError(cause && cause.message ? cause.message : String(cause));
					return;
				}
				const deadline = Date.now() + 60000;
				while (Date.now() < deadline) {
					await sleep(1000);
					const status = await readStatus();
					if (status !== null && status.boot !== previousBoot) {
						window.location.reload();
						return;
					}
				}
				setPhase("failed");
				setError(t("timeout"));
			}, [info, t]);

			const rows = [
				[t("pid"), info === null ? "—" : String(info.pid)],
				[t("port"), info === null || info.port === null || info.port === undefined ? "—" : String(info.port)],
				[t("startedAt"), info === null ? "—" : new Date(info.startedAt).toLocaleString()],
				[t("uptime"), info === null ? "—" : (formatDuration(info.uptimeMs + tick * 1000) ?? "—")]
			];

			let stateText = null;
			if (phase === "restarting") {
				stateText = React.createElement("span", { className: "dshr_state dshr_state_busy" },
					React.createElement("span", { className: "dshr_spinner" }),
					t("waiting", { seconds: elapsed }));
			} else if (phase === "failed") {
				stateText = React.createElement("span", { className: "dshr_state dshr_state_error" },
					t("restartFailed", { message: error === null ? t("unknown") : error }));
			} else if (statusError !== null) {
				stateText = React.createElement("span", { className: "dshr_state" },
					t("statusFailed", { message: statusError }));
			}

			return React.createElement("div", { className: "dshr_root" },
				React.createElement("div", { className: "dshr_card" },
					React.createElement("div", { className: "dshr_title" }, t("title")),
					React.createElement("div", { className: "dshr_desc" }, t("desc")),
					React.createElement("div", { className: "dshr_grid" },
						...rows.flatMap(([key, value]) => [
							React.createElement("div", { className: "dshr_key", key: key + "-k" }, key),
							React.createElement("div", { className: "dshr_val", key: key + "-v" }, value)
						])),
					React.createElement("div", { className: "dshr_actions" },
						React.createElement(primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: phase === "restarting",
							onClick: () => { void doRestart(); }
						}, phase === "restarting" ? t("restarting") : t("now")),
						stateText)));
		}

		//#region plugin
		const inject = ["slots", "locale"];

		/** 注册设置页与字典。 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-restart: dictionaries");
			const t = ctx.locale.bind(NS);
			// 设置外壳声明 settings.section 之后再挂载本页,顺序不受约束。
			ctx.slots.inject("settings.section", () => {
				const dispose = ctx.slots.register({
					name: "settings.section",
					id: "dsh-restart",
					order: 90,
					label: () => t("nav"),
					locale: NS
				}, RestartSection);
				return () => { dispose(); };
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		//#endregion

		return module.exports;
	}
});
