import ClockCore
import Foundation
import XCTest

/// The native clock's two formats, pinned to the SAME vector table
/// `test/clock.test.ts` reads (docs/feat/mobile-ui-fluidity-s2.md): one spec, two
/// implementations. Red when either side's rule changes alone (e.g. no zero-pad).
final class ClockCoreTests: XCTestCase {
    /// Read from the repo (relative to THIS file), never a bundled copy.
    private func vectors(_ format: String) throws -> [(Double, String)] {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // PushCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // PushCoreTests (package)
            .deletingLastPathComponent() // native-tests
            .deletingLastPathComponent() // mobile
            .appendingPathComponent("test/fixtures/clock-format-v1.json")
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        )
        let rows = try XCTUnwrap(json[format] as? [[Any]])
        return try rows.map { row in
            (try XCTUnwrap(row.first as? Double), try XCTUnwrap(row.last as? String))
        }
    }

    private func check(_ format: String) throws {
        let table = try vectors(format)
        XCTAssertGreaterThanOrEqual(table.count, 14)
        for (ms, label) in table {
            XCTAssertEqual(ClockCore.formatClock(format, ms), label, "\(format) \(ms)")
        }
    }

    func testThinkingVectors() throws {
        try check("thinking")
    }

    func testStepVectors() throws {
        try check("step")
    }

    /// A prop from JS must never trap the app in an `Int` conversion.
    func testNonFiniteAndHugeValuesDoNotTrap() {
        for ms in [Double.nan, Double.infinity, -Double.infinity] {
            XCTAssertEqual(ClockCore.formatClock("thinking", ms), "0 s")
            XCTAssertEqual(ClockCore.formatClock("step", ms), "")
        }
        XCTAssertFalse(ClockCore.formatClock("thinking", 1e300).isEmpty)
    }
}
