import Foundation

/// `apps/mobile/src/clock.ts` `formatClock`, byte for byte: both are pinned by
/// `apps/mobile/test/fixtures/clock-format-v1.json`
/// (docs/feat/mobile-ui-fluidity-s2.md). Foundation only, so `swift test` runs it.
public enum ClockCore {
    /// `"step"`: a running step's clock (`""` under 1 s, `2 min 5 s`); anything
    /// else: the Thinking row's steady-width one (`1 min 05 s`, `1 h 02 min`).
    public static func formatClock(_ format: String, _ ms: Double) -> String {
        let seconds = wholeSeconds(ms)
        if format == "step" {
            if seconds < 1 {
                return ""
            }
            return seconds < 60 ? "\(seconds) s" : "\(seconds / 60) min \(seconds % 60) s"
        }
        if seconds < 60 {
            return "\(seconds) s"
        }
        if seconds < 3600 {
            return "\(seconds / 60) min \(padded(seconds % 60)) s"
        }
        return "\(seconds / 3600) h \(padded((seconds % 3600) / 60)) min"
    }

    /// Floored, never negative, and never a trapping `Int` conversion.
    private static func wholeSeconds(_ ms: Double) -> Int {
        guard ms.isFinite, ms > 0 else {
            return 0
        }
        return Int(min(ms / 1000, 1e12))
    }

    private static func padded(_ n: Int) -> String {
        n < 10 ? "0\(n)" : "\(n)"
    }
}
