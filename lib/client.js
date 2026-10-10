/**
 * Browser half of dsh-continuechat.
 *
 * Adds one icon action to the finalized-assistant action row (the row that
 * already carries copy / rating / branch). It appears on the closing message of
 * a turn the harness had to cut short — stopped by hand, a failed model
 * request, a reply truncated by the output-token limit, or crash recovery — and
 * resumes that conversation by running the host `/continue` command through the
 * command RPC, exactly as if the line had been typed into the composer. The host
 * owns the prompt and the outcome row, so this half only owns the control, the
 * interruption read, and its failure reporting.
 *
 * Hand-written bundle: no build step, `react` from the platform seed table.
 */
window.__ModuleLoader__.load({
	id: "dsh-continuechat",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		//#region constants
		/** Dictionary namespace owned by this plugin. */
		const NS = "continue-chat";
		/** Stable id for the action entry and its injected stylesheet. */
		const PLUGIN_ID = "dsh-continuechat";
		/** The host command this control runs. */
		const COMMAND_LINE = "/continue";
		/** The finalized-assistant action row. */
		const SLOT = "conversation.chat.assistant-actions";
		/**
		 * Turn-end reasons after which the conversation still has work in it.
		 * Mirrors the host half: `completed` finished the work, `blocked` never
		 * entered a step, and `forked` merely closes an inherited prefix.
		 */
		const RESUMABLE_KINDS = new Set(["aborted", "error", "max-tokens", "interrupted"]);
		//#endregion

		//#region styles
		const css = [
			".dshContinueChat_action{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:calc(28px + var(--dsh-content-font-delta,0px));border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(13px + var(--dsh-content-font-delta-secondary,0px));line-height:20px;white-space:nowrap;cursor:pointer;padding:0 8px;transition:background-color .12s,color .12s}",
			".dshContinueChat_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".dshContinueChat_action:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
			".dshContinueChat_action:disabled{cursor:default;opacity:.4}",
			".dshContinueChat_glyph{flex:none;width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}",
			".dshContinueChat_failure{color:var(--dsw-alias-label-tertiary);padding-left:4px;font-size:13px;line-height:20px}",
		].join("");
		const cssTagId = `${PLUGIN_ID}/continue-action.css`;
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(cssTagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = cssTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const styles = {
			action: "dshContinueChat_action",
			glyph: "dshContinueChat_glyph",
			failure: "dshContinueChat_failure",
		};
		//#endregion

		//#region dictionaries
		/** Chinese copy (the harness default locale). */
		const zh = {
			"action.label": "继续对话",
			"action.busy": "继续中…",
			"action.title": "从中断处继续上一次生成：手动停止、请求失败或输出截断后均可使用",
			"action.failed": "继续失败",
			"unknownCommand": "未找到 /continue 命令：宿主插件可能未加载",
		};
		/** English copy. */
		const en = {
			"action.label": "Continue",
			"action.busy": "Continuing…",
			"action.title": "Resume the last run from where it stopped — after a manual stop, a failed request, or a cut-off reply",
			"action.failed": "Continue failed",
			"unknownCommand": "Unknown command /continue: the host plugin may not be loaded",
		};
		//#endregion

		//#region interruption read
		/** The value every message but the interrupted one reads. */
		const IDLE = Object.freeze({ messageId: null, reason: null });

		/**
		 * Find the assistant message whose turn ended early, if the newest turn did.
		 *
		 * The window is the session's loaded event page; the newest turn boundary
		 * always sits at its tail, so both scans stop near the end in practice.
		 * @param entries - the session event window entries, oldest first.
		 * @returns `{ messageId, reason }` for the resumable closing message, else IDLE.
		 */
		function findResumeTarget(entries) {
			if (!Array.isArray(entries) || entries.length === 0) return IDLE;
			let turn;
			let kind;
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const event = entries[index]?.event;
				if (event?.type !== "turn/end") continue;
				turn = event.data?.turn;
				kind = event.data?.reason?.kind;
				break;
			}
			if (turn === undefined || !RESUMABLE_KINDS.has(kind)) return IDLE;
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const event = entries[index]?.event;
				if (event?.type !== "assistant/message" || event.data?.turn !== turn) continue;
				const messageId = event.data?.message?.id;
				if (typeof messageId === "string") return { messageId, reason: kind };
			}
			return IDLE;
		}

		/**
		 * Wrap one session event feed as a `useSyncExternalStore` source.
		 *
		 * The window snapshot is memoized per revision so every mounted action
		 * reads the same object identity and React can bail out of the untouched
		 * rows instead of re-rendering the whole transcript.
		 * @param source - the session binding's event feed, or undefined.
		 * @returns the `{ read, subscribe }` pair handed to the component.
		 */
		function createResumeSource(source) {
			let revision = -1;
			let value = IDLE;
			let announced = false;
			return {
				read: () => {
					const snapshot = source === undefined ? undefined : source.getSnapshot();
					const current = snapshot === undefined ? -1 : snapshot.revision;
					if (current !== revision) {
						revision = current;
						value = snapshot === undefined ? IDLE : findResumeTarget(snapshot.entries);
						if (value !== IDLE) {
							console.info(
								`[dsh-continuechat] resumable turn (${value.reason}) closes message ${value.messageId}`,
							);
						} else if (!announced && Array.isArray(snapshot?.entries) && snapshot.entries.length > 0) {
							announced = true;
							const lastEnd = [...snapshot.entries]
								.reverse()
								.find((entry) => entry?.event?.type === "turn/end");
							console.info(
								`[dsh-continuechat] event window: ${snapshot.entries.length} entries, last turn/end = ${lastEnd?.event?.data?.reason?.kind ?? "(none)"}`,
							);
						}
					}
					return value;
				},
				subscribe: (listener) => (source === undefined ? () => {} : source.subscribe(listener)),
			};
		}
		//#endregion

		//#region component
		/**
		 * The action-row control that resumes the interrupted conversation. Renders
		 * nothing unless this exact message closed a turn that ended early.
		 * @param props - slot runtime props plus this entry's injected values.
		 * @returns the action button, or null on every other message.
		 */
		function ContinueAction({ messageId, useSession, resumeSource, resume, t }) {
			const target = React.useSyncExternalStore(resumeSource.subscribe, resumeSource.read);
			const running = useSession((state) => state.running);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const alive = React.useRef(true);
			React.useEffect(() => {
				alive.current = true;
				return () => {
					alive.current = false;
				};
			}, []);

			if (target.messageId !== messageId || running === true) return null;

			const onClick = () => {
				setBusy(true);
				setError(null);
				resume().then(
					(failure) => {
						if (!alive.current) return;
						setBusy(false);
						if (failure !== null && failure !== undefined) setError(failure);
					},
					(reason) => {
						if (!alive.current) return;
						setBusy(false);
						setError(reason instanceof Error ? reason.message : String(reason));
					},
				);
			};

			return React.createElement(
				React.Fragment,
				null,
				React.createElement(
					"button",
					{
						type: "button",
						className: styles.action,
						title: t("action.title"),
						"aria-label": t("action.title"),
						disabled: busy,
						onClick,
					},
					React.createElement(
						"svg",
						{
							className: styles.glyph,
							viewBox: "0 0 16 16",
							"aria-hidden": true,
						},
						React.createElement("path", { d: "M5 3.2v9.6L13 8 5 3.2Z", fill: "currentColor" }),
					),
					t(busy ? "action.busy" : "action.label"),
				),
				error === null
					? null
					: React.createElement("span", { className: styles.failure, role: "status", title: error }, t("action.failed")),
			);
		}
		//#endregion

		//#region plugin
		/** Cordis plugin name for the browser half. */
		const name = "continue-chat/client";
		/** Client services required before apply runs. */
		const inject = ["slots", "sessions", "remote", "remote.commands", "locale"];

		/**
		 * Register the dictionaries and the assistant action-row entry.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "continue-chat: dictionaries");
			const t = ctx.locale.bind(NS);
			console.info(`[dsh-continuechat] browser half ready — action row "${SLOT}"`);
			let warnedNoBinding = false;

			ctx.slots.inject(SLOT, () =>
				ctx.slots.register(
					{
						name: SLOT,
						id: PLUGIN_ID,
						order: 100,
						locale: NS,
						inject: (sessionId) => {
							const binding = ctx.sessions.binding(sessionId);
							if (binding === undefined && !warnedNoBinding) {
								warnedNoBinding = true;
								console.warn(
									`[dsh-continuechat] no client session binding for "${sessionId}"; the continue action stays hidden`,
								);
							}
							return {
								resumeSource: createResumeSource(binding === undefined ? undefined : binding.eventSource),
								/**
								 * Run the host `/continue` command against this session.
								 * @returns a failure message, or null when the host accepted it.
								 */
								resume: async () => {
									const result = await ctx.remote.commands.execute(sessionId, COMMAND_LINE, []);
									if (!result.ok) return `${result.error.message} (${result.error.code})`;
									if (result.value === undefined) return t("unknownCommand");
									if (result.value.result.kind === "error") return result.value.result.text;
									return null;
								},
							};
						},
					},
					ContinueAction,
				),
			);
		}
		//#endregion

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
