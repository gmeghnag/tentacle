/**
 * The `--resume` session picker (docs/feat/resume-picker.md): a header and a
 * column of sessions styled like the command palette (accent `❯` row, the rest
 * dimmed). The logic — window, ages, keys — lives in `session-picker.ts`.
 */
import { Box, Text, useApp, useInput } from "ink";
import { type ReactElement, useEffect, useRef, useState } from "react";
import {
  type PickerView,
  type SessionChoice,
  movePicker,
  pickerKey,
  pickerView,
} from "../session-picker.ts";
import { accentHex } from "../theme.ts";

const HINT = "↑↓ choose · Enter resume · Esc cancel";

export function SessionPicker({
  view,
  columns,
}: {
  view: PickerView;
  columns: number;
}): ReactElement {
  const metas = view.rows.map((r) => `${r.age} · ${r.meta}`);
  const metaWidth = metas.reduce((w, m) => Math.max(w, m.length), 0);
  const longest = view.rows.reduce((w, r) => Math.max(w, r.title.length), 0);
  // "❯ " + title + "  " + meta must fit the terminal; the title gives way.
  const titleWidth = Math.max(1, Math.min(longest, columns - metaWidth - 4));
  return (
    <Box flexDirection="column" width={columns}>
      <Text wrap="truncate">
        <Text bold>Resume a session</Text>
        <Text dimColor> ({HINT})</Text>
      </Text>
      {view.above > 0 ? <Text dimColor>{`  ↑ ${view.above} more`}</Text> : null}
      {view.rows.map((row, i) => (
        <Box key={row.id}>
          <Text color={row.selected ? accentHex : undefined} dimColor={!row.selected}>
            {row.selected ? "❯ " : "  "}
          </Text>
          <Box width={titleWidth} flexShrink={0}>
            <Text
              color={row.selected ? accentHex : undefined}
              dimColor={!row.selected}
              wrap="truncate"
            >
              {row.title}
            </Text>
          </Box>
          <Text dimColor>{`  ${metas[i]}`}</Text>
        </Box>
      ))}
      {view.below > 0 ? <Text dimColor>{`  ↓ ${view.below} more`}</Text> : null}
    </Box>
  );
}

/**
 * The picker with its selection state. Answers `onDone` exactly once (the
 * chosen id, or null on Esc/Ctrl+C), then renders nothing — so the frame is
 * erased from the scrollback — and exits its Ink instance.
 */
export function SessionPickerApp({
  choices,
  now,
  height,
  columns,
  onDone,
}: {
  choices: readonly SessionChoice[];
  now: number;
  height: number;
  columns: number;
  onDone: (id: string | null) => void;
}): ReactElement | null {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const [done, setDone] = useState(false);
  const answered = useRef(false);

  useInput((input, key) => {
    if (answered.current) {
      return;
    }
    const action = pickerKey(input, key);
    if (action === "up" || action === "down") {
      setSelected((s) => movePicker(s, action === "up" ? -1 : 1, choices.length));
      return;
    }
    if (action === "choose" || action === "cancel") {
      answered.current = true;
      onDone(action === "choose" ? (choices[selected]?.id ?? null) : null);
      setDone(true);
    }
  });

  useEffect(() => {
    if (done) {
      exit(); // after the empty frame has been written
    }
  }, [done, exit]);

  if (done) {
    return null;
  }
  return <SessionPicker view={pickerView(choices, selected, now, height)} columns={columns} />;
}
