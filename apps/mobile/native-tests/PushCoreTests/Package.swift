// swift-tools-version:5.9
// The Notification Service Extension's LOGIC, under `swift test` on macOS
// (docs/feat/mobile-notifications.md N5, decision 20). The extension's own
// `PushCore/*.swift` files depend on Foundation + CryptoKit only (never UIKit),
// so this package compiles THEM — one implementation, no copy — through the
// `Sources/PushCore` symlink, which points at the extension's folder.
//
// `bun run test:swift` runs it (macOS only; part of `bun run e2e:mobile`'s
// preflight, mandatory before merge). The vector files are symlinks too, to the
// ONE copy each: `packages/transport/test/vectors/push-v1.json` (task 16) and
// `apps/mobile/test/fixtures/push-render-v1.json` (N2).
import PackageDescription

let package = Package(
    name: "PushCoreTests",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "PushCore"),
        // Task 18's widget logic, in the same package for the same reason: it is
        // UIKit-free, so `swift test` runs it on macOS against the SAME vectors
        // the TypeScript spec asserts (one spec, two implementations).
        .target(name: "LACore", dependencies: ["PushCore"]),
        .testTarget(
            name: "PushCoreTests",
            dependencies: ["PushCore", "LACore"],
            path: "Tests/PushCoreTests"
        ),
    ]
)
