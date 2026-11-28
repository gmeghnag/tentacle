import CoreText
import ExpoModulesCore
import UIKit

/// A label that counts the time since `since` (epoch ms) on the MAIN thread, so it
/// keeps time while the JS thread is busy (docs/feat/mobile-ui-fluidity-s2.md).
/// The format is `ClockCore`'s; the fonts and sizes come resolved from JS
/// (`src/ui/ClockText.tsx`).
final class ClockTextView: ExpoView {
    private let label = UILabel()
    private var timer: Timer?

    var since: Double = 0
    var format = "step"
    var fontSize: CGFloat = 13
    var lineHeight: CGFloat = 18
    /// The app font's face; nil = the system font.
    var fontFamily: String?
    var color: UIColor = .label
    var tabular = false

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        // A width boundary crossed before the new size lands still draws whole.
        clipsToBounds = false
        isAccessibilityElement = true
        label.isAccessibilityElement = false
        addSubview(label)
    }

    deinit {
        timer?.invalidate()
    }

    func propsDidChange() {
        label.font = resolvedFont()
        label.textColor = color
        showNow()
        // The props of a first mount land before the shadow state `setViewSize`
        // writes to: measure on the next turn.
        scheduleFit()
        restart()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            stop()
            return
        }
        showNow()
        scheduleFit()
        restart()
    }

    override func removeFromSuperview() {
        stop()
        super.removeFromSuperview()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeLabel()
        scheduleFit()
    }

    private var nowMs: Double {
        Date().timeIntervalSince1970 * 1000
    }

    private func resolvedFont() -> UIFont {
        guard let family = fontFamily, let custom = UIFont(name: family, size: fontSize) else {
            return tabular
                ? UIFont.monospacedDigitSystemFont(ofSize: fontSize, weight: .regular)
                : UIFont.systemFont(ofSize: fontSize)
        }
        guard tabular else {
            return custom
        }
        let descriptor = custom.fontDescriptor.addingAttributes([
            .featureSettings: [
                [
                    UIFontDescriptor.FeatureKey.type: kNumberSpacingType,
                    UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector,
                ],
            ],
        ])
        return UIFont(descriptor: descriptor, size: fontSize)
    }

    /// Writes the label only when the text changed.
    private func showNow() {
        let text = ClockCore.formatClock(format, max(0, nowMs - since))
        if label.text != text {
            label.text = text
            accessibilityLabel = text
        }
        placeLabel()
    }

    private var fittedWidth: CGFloat {
        ceil(label.intrinsicContentSize.width)
    }

    private func placeLabel() {
        label.frame = CGRect(x: 0, y: 0, width: max(0, fittedWidth), height: lineHeight)
    }

    private func scheduleFit() {
        DispatchQueue.main.async { [weak self] in
            self?.fit()
        }
    }

    /// Tells Yoga the label's size, only when the WIDTH differs from the box's.
    private func fit() {
        let width = fittedWidth
        if abs(bounds.width - width) < 0.5 && abs(bounds.height - lineHeight) < 0.5 {
            return
        }
        setViewSize(CGSize(width: width, height: lineHeight))
    }

    private func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// One shot, aimed at the next whole second of `now - since`, so a late fire is
    /// not carried into the next one. `.common` keeps it ticking during a scroll.
    private func restart() {
        stop()
        guard window != nil else {
            return
        }
        var into = (nowMs - since).truncatingRemainder(dividingBy: 1000)
        if !into.isFinite {
            into = 0
        } else if into < 0 {
            into += 1000
        }
        let next = Timer(timeInterval: (1000 - into) / 1000, repeats: false) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(next, forMode: .common)
        timer = next
    }

    private func tick() {
        let before = fittedWidth
        showNow()
        if fittedWidth != before {
            fit()
        }
        restart()
    }
}
