import type { PermissionRequest } from "@tentacle/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { permissionDetailLines, permissionShowsCwd } from "../permission-ui.ts";
import { accentHex } from "../theme.ts";

// Brand accent (matches the theme's `accent`), used for the frame + selection.
const ACCENT = accentHex;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Fixed row count of the dialog for a given option / detail-row count (App sizes the viewport). */
export function permissionPromptRows(optionCount: number, detailRows = 1, cwdRow = true): number {
  // title + subject rows + cwd (tool calls only) + options + footer
  return 2 + detailRows + (cwdRow ? 1 : 0) + optionCount;
}

/**
 * A framed, arrow-navigable approval dialog (Claude-Code style). Keys are
 * handled in `App` (↑/↓ + enter, or y / a / n, Esc). The selected option is
 * highlighted; options come pre-built from the request.
 */
export function PermissionPrompt({
  req,
  options,
  selected,
  cwd,
  columns = 80,
}: {
  req: PermissionRequest;
  options: readonly string[];
  selected: number;
  cwd: string;
  columns?: number;
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
      {options.map((label, i) => {
        const active = i === selected;
        return (
          <Text key={label} color={active ? ACCENT : undefined} bold={active}>
            {active ? "❯ " : "  "}
            {label}
          </Text>
        );
      })}
      <Text dimColor> ↑↓ choose · enter confirm · y/a/n · esc deny</Text>
    </Box>
  );
}
