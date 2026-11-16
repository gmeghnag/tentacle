/**
 * docs/feat/app-decomposition.md S10 — the TUI's frame, as a component that
 * renders and nothing else (AGENTS §7).
 *
 * This file is `App.tsx`'s old `return ( … )` moved out VERBATIM (the plan's own
 * constraint on S10: "a verbatim JSX move — no prop re-plumbing", M3). Every
 * derived value it paints is computed by `app-layout.ts`'s `frameLayout`; here it
 * is destructured back to the pre-move identifiers, so the tree below is
 * character-for-character what the App returned, and a reader can check the move
 * with `git diff --color-moved`.
 *
 * What this component must NOT own, and does not:
 *   - no `useState`/`useRef`/`useEffect`/`useCallback` (no state, no effect, no
 *     ref: `App` owns them, and its effect list is frozen — Fable H1);
 *   - no geometry decision: the viewport, the bottom area's rows, the dock's
 *     height and top, the panel's body row and the status bar's row are
 *     `app-layout.ts`'s, never re-derived here (the S0 review's warning: the
 *     frame set cannot see box geometry, so it must not be re-invented);
 *   - no key handling (the ONE `useInput` stays in `App`: Ink calls every active
 *     listener, so precedence must stay one ordered decision).
 *
 * The pure text helpers it calls are the ones the inline tree already called
 * (`rowTexts`, `stripAnsi`, `rowSelectionRange`, `inputRuleText`,
 * `quitConfirmText`, `permissionAgentLine`, `loadingLabel`, `dimProps`,
 * `palette`): they are formatting, already pure and unit-tested, and moving THEM
 * would be the redesign the plan defers to a later task (Owner Q5: a move slice
 * renames nothing).
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { type AppViewModel, MAX_INPUT_ROWS } from "./app-layout.ts";
import { quitConfirmText } from "./commands.ts";
import { BackgroundList, JobDrawer, SubagentDrawer } from "./components/BackgroundList.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { LineInput } from "./components/LineInput.tsx";
import { ListPanel } from "./components/ListPanel.tsx";
import { PermissionPrompt } from "./components/PermissionPrompt.tsx";
import { QueuedMessages } from "./components/QueuedMessages.tsx";
import { QuitConfirm } from "./components/QuitConfirm.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { Thinking } from "./components/Thinking.tsx";
import { VoiceStrip } from "./components/VoiceStrip.tsx";
import { permissionAgentLine } from "./permission-ui.ts";
import { rowTexts } from "./queued.ts";
import { stripAnsi } from "./render-lines.ts";
import { rowSelectionRange } from "./selection.ts";
import { SEND_NOW_HINT } from "./send-now.ts";
import { inputRuleText } from "./status-line.ts";
import { dimProps, palette } from "./theme.ts";
import { loadingLabel } from "./turn-feed.ts";

const INPUT_PLACEHOLDER = "Type a task or /command";

export function AppView({ model }: { readonly model: AppViewModel }): ReactElement {
  // The pre-move identifiers, restored from the view-model, so the tree below is
  // the tree that was inline in `App` (Fable M1: no use-site edits).
  const {
    st,
    field,
    permission,
    dock,
    drawerJob,
    linkView,
    shownModel,
    shownTarget,
    cwd,
    contextWindow,
    expandAll,
    selection,
    quitConfirm,
    hopRow,
    loading,
    compacting,
    columns,
    tokensShown,
    ctxShown,
    paletteOpen,
    commandSel,
    paletteWin,
    paletteRows,
    listView,
    capsShown,
    shown,
    dockView,
    drawer,
    pill,
    replyShown,
    viewport,
    win,
    visible,
    scrolledUp,
    hiddenAbove,
    attachRow,
    voiceStrip,
    onPillRange,
  } = model;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={viewport}>
        {selection ? (
          visible.map((row, i) => {
            const absRow = win.start + i;
            const plain = stripAnsi(row);
            // Ink measures an empty <Text> as 0x0, so blank separator rows
            // would collapse and shift the transcript up. A single space keeps
            // every row at height 1 (the grid trimEnd()s it back to "").
            const display = row === "" ? " " : row;
            const line = row === "" ? " " : plain;
            const range = rowSelectionRange(selection, absRow, plain.length);
            if (!range) {
              return <Text key={i}>{display}</Text>;
            }
            const [c0, c1] = range;
            return (
              <Text key={i}>
                {line.slice(0, c0)}
                <Text inverse>{line.slice(c0, c1)}</Text>
                {line.slice(c1)}
              </Text>
            );
          })
        ) : (
          <Text>{visible.join("\n")}</Text>
        )}
      </Box>

      <Box marginTop={1}>
        {quitConfirm !== null ? (
          <QuitConfirm text={quitConfirmText(quitConfirm)} columns={columns} />
        ) : permission.pending ? (
          <PermissionPrompt
            req={permission.pending}
            options={permission.choices.map((c) => c.label)}
            selected={permission.selected}
            cwd={cwd}
            columns={columns}
            {...(replyShown ? { reply: replyShown } : {})}
            replyable={permission.choices.some((c) => c.reply === true)}
            {...(permission.pendingAgent
              ? { agentLine: permissionAgentLine(permission.pendingAgent, columns) }
              : {})}
          />
        ) : (
          <Box flexDirection="column" width={columns}>
            {/* Queued messages sit where a sent message would (right under the
                conversation); the thinking/working line stays just above the
                input, under them (owner, 2026-10-25). */}
            {st.running || compacting ? (
              <QueuedMessages queued={rowTexts(shown)} hint={SEND_NOW_HINT} columns={columns} />
            ) : null}
            {/* One blank row between the send-now hint and the thinking line. */}
            {st.running && shown.length > 0 ? <Text> </Text> : null}
            {loading ? (
              <Text {...dimProps()}>{loadingLabel(loading.done, loading.total)}</Text>
            ) : st.running ? (
              <Thinking
                since={
                  st.reasoning && st.reasoningStartedAt !== null
                    ? st.reasoningStartedAt
                    : (st.turnStartedAt ?? Date.now())
                }
                label={st.reasoning ? "Thinking…" : "Working…"}
              />
            ) : null}
            {listView ? (
              <ListPanel view={listView} columns={columns} />
            ) : (
              <>
                {paletteOpen ? (
                  <CommandPalette
                    commands={paletteRows}
                    selected={commandSel - paletteWin.start}
                    columns={columns}
                  />
                ) : null}
                {/* The dock ABOVE the input (docs/feat/subagent-panel.md, UI
                    revision): the dropdown, or the one child opened. Everything
                    it shows is a precomputed view-model — these components only
                    paint segments (AGENTS §7). Its rows are reserved in
                    `activeRows`, so the input and the status bar never move. */}
                {dockView !== null ? <BackgroundList view={dockView} columns={columns} /> : null}
                {drawer !== null && drawerJob !== null ? (
                  <JobDrawer
                    head={drawer.head}
                    hidden={drawer.hidden}
                    tail={drawer.tail}
                    columns={columns}
                  />
                ) : drawer !== null ? (
                  <SubagentDrawer
                    head={drawer.head}
                    hidden={drawer.hidden}
                    tail={drawer.tail}
                    sent={drawer.sent}
                    columns={columns}
                  />
                ) : null}
                {/* The input's top edge, which says ONE thing depending on the
                    dock: `── <model> ─` at rest, a PLAIN line under the
                    dropdown (its bottom edge), or `─ → sa-N · enter sends ·
                    esc back ───` while a child is open. Never two labelled
                    rules stacked, and never the model while the dock shows
                    anything (owner). */}
                <Text color={palette().border}>
                  {inputRuleText(
                    // A JOB's drawer is read-only and the input stays on the main
                    // agent: a PLAIN rule, no `→ bg-3` (owner Q1 (a)).
                    dock.focus.kind === "open" && drawerJob === null
                      ? { kind: "target", id: dock.focus.id, ended: dock.focus.ended !== null }
                      : dock.focus.kind === "list" || dock.focus.kind === "open"
                        ? { kind: "plain" }
                        : { kind: "model" },
                    shownModel,
                    columns,
                  )}
                </Text>
                <Box
                  width={columns}
                  borderStyle="round"
                  borderColor={palette().border}
                  borderTop={false}
                  borderLeft={false}
                  borderRight={false}
                  flexDirection="column"
                >
                  <VoiceStrip view={voiceStrip ?? null} columns={columns} />
                  {attachRow === null ? null : (
                    // ONE row, above the input: the chips (`name size`, +N) or
                    // the upload in flight. Colours and the glyph only — the
                    // text is `attach-draft.ts`'s (docs/feat/attachments-tui.md D8).
                    <Text color={palette().subtle} wrap="truncate-end">
                      {attachRow.kind === "upload"
                        ? `  ${attachRow.text}`
                        : `  📎 ${attachRow.items.join("  ")}${attachRow.more > 0 ? `  +${attachRow.more}` : ""}`}
                    </Text>
                  )}
                  <LineInput
                    value={field.value}
                    cursor={field.cursor}
                    anchor={field.anchor}
                    placeholder={st.running ? "Queue a task…" : INPUT_PLACEHOLDER}
                    maxRows={MAX_INPUT_ROWS}
                    width={columns}
                  />
                </Box>
              </>
            )}
          </Box>
        )}
      </Box>

      {hopRow === null ? (
        <StatusBar
          cwd={cwd}
          target={shownTarget}
          tokens={tokensShown.totals}
          contextTokens={ctxShown.used}
          contextApprox={ctxShown.approx}
          contextWindow={contextWindow}
          columns={columns}
          scrolledUp={scrolledUp}
          hiddenAbove={hiddenAbove}
          expandAll={expandAll}
          autoApprove={permission.autoApprove}
          capsMarker={capsShown}
          pill={pill}
          onPillRange={onPillRange}
          link={linkView}
        />
      ) : (
        // A hop in flight owns the status row (D3): same ONE row, so the frame
        // never changes height and the transcript keeps its position.
        <Box width={columns}>
          <Text color={palette().accent} wrap="truncate-end">
            {hopRow}
          </Text>
        </Box>
      )}
    </Box>
  );
}
