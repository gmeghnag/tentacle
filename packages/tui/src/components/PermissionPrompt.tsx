import type { PermissionRequest } from "@tentacle/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MENU_FOOTER, MENU_FOOTER_REPLY, type ReplyView } from "../permission-reply.ts";
import { permissionDetailLines, permissionShowsCwd } from "../permission-ui.ts";
import { accentHex } from "../theme.ts";

// Brand accent (matches the theme's `accent`), used for the frame + selection.
const ACCENT = accentHex;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Fixed row count of the dialog for a given option / detail-row count (App
 * sizes the viewport). `replyRows`: the reply field is open with that many
 * field rows — its prompt row + the field replace the options.
 */
export function permissionPromptRows(
  optionCount: number,
  detailRows = 1,
  cwdRow = true,
  replyRows?: number,
): number {
  // title + subject rows + cwd (tool calls only) + options (or prompt + field) + footer
  const body = replyRows === undefined ? optionCount : 1 + replyRows;
  return 2 + detailRows + (cwdRow ? 1 : 0) + body;
}

/**
 * A framed, arrow-navigable approval dialog (Claude-Code style). Keys are
 * handled in `App` (`permission-reply.ts` decides them). The selected option is
 * highlighted; options come pre-built from the request. `reply`: the reply
 * field is open — its view (prompt, rows, footer) replaces the options.
 */
export function PermissionPrompt({
  req,
  options,
  selected,
  cwd,
  columns = 80,
  reply,
  replyable = false,
}: {
  req: PermissionRequest;
  options: readonly string[];
  selected: number;
  cwd: string;
  columns?: number;
  reply?: ReplyView;
  replyable?: boolean;
}): ReactElement {
  const titlePrefix = `╭─ ${req.title} `;
  const dashes = Math.max(0, columns - titlePrefix.length - 1);

  return (
    <Box flexDirection="column">
      <Text color={ACCENT}>
        {titlePrefix}
        {"─".repeat(dashes)}
      </Text>
      {permissionDetailLines(req).map((line, i) => (
        <Text key={i} dimColor>
          {" "}
          {truncate(line, Math.max(10, columns - 3))}
        </Text>
      ))}
      {permissionShowsCwd(req) ? (
        <Text dimColor> {truncate(cwd, Math.max(10, columns - 24))} · writes confined here</Text>
      ) : null}
      {reply ? (
        <>
          <Text color={ACCENT}> {reply.prompt}</Text>
          {reply.rows.map((row, i) => (
            <Text key={i}>
              <Text color={row.gutter ? "gray" : ACCENT}>{row.prefix}</Text>
              {row.segments.map((seg, j) => (
                <Text key={j} inverse={seg.inverse}>
                  {seg.text}
                </Text>
              ))}
            </Text>
          ))}
          <Text dimColor>{reply.footer}</Text>
        </>
      ) : (
        <>
          {options.map((label, i) => {
            const active = i === selected;
            return (
              <Text key={label} color={active ? ACCENT : undefined} bold={active}>
                {active ? "❯ " : "  "}
                {label}
              </Text>
            );
          })}
          <Text dimColor>{replyable ? MENU_FOOTER_REPLY : MENU_FOOTER}</Text>
        </>
      )}
    </Box>
  );
}
