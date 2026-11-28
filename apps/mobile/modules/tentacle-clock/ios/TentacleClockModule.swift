import ExpoModulesCore
import UIKit

public class TentacleClockModule: Module {
    public func definition() -> ModuleDefinition {
        Name("TentacleClock")

        View(ClockTextView.self) {
            Prop("since") { (view: ClockTextView, since: Double) in
                view.since = since
            }
            Prop("format") { (view: ClockTextView, format: String) in
                view.format = format
            }
            Prop("fontSize") { (view: ClockTextView, size: Double) in
                view.fontSize = CGFloat(size)
            }
            Prop("lineHeight") { (view: ClockTextView, height: Double) in
                view.lineHeight = CGFloat(height)
            }
            Prop("fontFamily") { (view: ClockTextView, family: String?) in
                view.fontFamily = family
            }
            Prop("color") { (view: ClockTextView, color: UIColor) in
                view.color = color
            }
            Prop("tabular") { (view: ClockTextView, tabular: Bool) in
                view.tabular = tabular
            }
            OnViewDidUpdateProps { (view: ClockTextView) in
                view.propsDidChange()
            }
        }
    }
}
