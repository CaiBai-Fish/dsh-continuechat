/**
 * Browser half of dsh-continuechat.
 *
 * Adds one action to the completed-turn footer of a turn the harness had to cut
 * short — stopped by hand, a failed model request, a reply truncated by the
 * output-token limit, or a turn closed by crash recovery — and resumes that
 * conversation by running the host `/continue` command through the command RPC,
 * exactly as if the line had been typed into the composer. The host owns the
 * prompt and the outcome row, so this half only owns the control, the
 * interruption read, and its failure reporting.
 *
 * Why the turn footer and not the per-message action row: Chat freezes an
 * interrupted stream as a partial assistant node that carries no durable
 * `messageId`, and `conversation.chat.assistant-actions` renders only for a
 * closing message that has one; a crash-recovered turn has no closing message
 * at all. The completed-turn footer (`conversation.chat.turnTail`) renders for
 * every closed turn, so it hosts the action in every case, including a turn
 * that produced no assistant output.
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
		/** The completed-turn footer chain, rendered for every closed turn. */
		const SLOT = "conversation.chat.turnTail";
		/**
		 * Turn-end reasons after which the conversation still has work in it.
		 * Mirrors the host half: `completed` finished the work, `blocked` never
		 * entered a step, and `forked` merely closes an inherited prefix.
		 */
		const RESUMABLE_KINDS = new Set(["aborted", "error", "max-tokens", "interrupted"]);
		//#endregion

		//#region styles
		const css = [
			".dshContinueChat_footer{display:flex;align-items:center;gap:6px;margin-left:-6px}",
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
			footer: "dshContinueChat_footer",
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
		/** The value every turn but the newest resumable one reads. */
		const IDLE = null;

		/**
		 * Find the turn whose end left the conversation resumable, if the newest
		 * turn is the one that did.
		 *
		 * The window is the session's loaded event page; the newest turn boundary
		 * always sits at its tail, so the scan stops near the end in practice.
		 * @param entries - the session event window entries, oldest first.
		 * @returns `{ turn, reason }` for the newest interrupted turn, else null.
		 */
		function findResumeTurn(entries) {
			if (!Array.isArray(entries) || entries.length === 0) return IDLE;
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const event = entries[index]?.event;
				if (event?.type !== "turn/end") continue;
				const turn = event.data?.turn;
				const kind = event.data?.reason?.kind;
				if (turn === undefined || !RESUMABLE_KINDS.has(kind)) return IDLE;
				return { turn, reason: kind };
			}
			return IDLE;
		}

		/**
		 * Wrap one session event feed as a `useSyncExternalStore` source.
		 *
		 * The window snapshot is memoized per revision so every mounted action
		 * reads the same object identity and React can bail out of the untouched
		 * turns instead of re-rendering the whole transcript.
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
						value = snapshot === undefined ? IDLE : findResumeTurn(snapshot.entries);
						if (value !== IDLE) {
							console.info(
								`[dsh-continuechat] resumable turn (${value.reason}) closes turn ${value.turn}`,
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
		 * The footer control that resumes the interrupted conversation. Renders
		 * nothing unless this exact turn is the newest one and ended early.
		 * @param props - slot runtime props plus this entry's injected values.
		 * @returns the action, or null on every other turn.
		 */
		function TurnTailContinue({ turn, resumeSource, resume, t, useSession }) {
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

			if (target === IDLE || turn === undefined || target.turn !== turn.turn || running === true) return null;

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
				"div",
				{ className: styles.footer },
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
		 * Register the dictionaries and the completed-turn footer entry.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "continue-chat: dictionaries");
			const t = ctx.locale.bind(NS);
			console.info(`[dsh-continuechat] browser half ready — turn footer "${SLOT}"`);
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
					TurnTailContinue,
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
