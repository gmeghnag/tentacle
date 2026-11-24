/**
 * The project's workflows at rest (docs/feat/workflows-ui.md D8, slice 2b): ONE
 * summary line in the live area, above the queued/slot block — the workflows this
 * project HAS when no run is in flight.
 *
 * AGENTS §7: the text, its tier and its tone are `workflow-view.ts`'s
 * (`workflowsLine`); this component maps that tone to a theme token and paints
 * one row. It re-derives no cell, so a frames test can assert the row equals the
 * projection. Its row is already inside the frame's `activeRows`
 * (`catalogueHeight`), so painting it never moves the input.
 */
import { Text } from "ink";
import type { ReactElement } from "react";
import type { RailLine } from "../workflow-view.ts";
import { toneProps } from "./dock-tone.ts";

export function WorkflowsLine({ line }: { readonly line: RailLine }): ReactElement {
  return (
    <Text wrap="truncate-end" {...toneProps(line.tone)}>
      {line.text === "" ? " " : line.text}
    </Text>
  );
}
