// The transcript preview cards' native half (docs/feat/mobile-file-preview-cards.md):
// two functions and no state. Every rule — which card wants a preview, the size
// asked for, where the image is kept, what a failure shows — lives in the pure
// TypeScript modules; this file only turns a local file into pixels.
import ExpoModulesCore
import PDFKit
import QuickLookThumbnailing
import UIKit

public class TentaclePreviewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TentaclePreview")

    // A QuickLook THUMBNAIL (never the file-type icon: `.thumbnail` only, so a
    // type QuickLook cannot draw rejects and the card shows its symbol) of the
    // file at `fileUri`, fitted inside `widthPt × heightPt` at the screen scale,
    // written as JPEG to `outUri`. Resolves the image's pixel size.
    AsyncFunction("thumbnail") { (fileUri: String, outUri: String, widthPt: Double, heightPt: Double, promise: Promise) in
      guard let file = URL(string: fileUri), file.isFileURL,
        let out = URL(string: outUri), out.isFileURL
      else {
        promise.reject("E_PREVIEW_URI", "not a file uri")
        return
      }
      let scale = UIScreen.main.scale
      let request = QLThumbnailGenerator.Request(
        fileAt: file,
        size: CGSize(width: widthPt, height: heightPt),
        scale: scale,
        representationTypes: .thumbnail
      )
      QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, error in
        guard let image = representation?.uiImage, let data = image.jpegData(compressionQuality: 0.85)
        else {
          promise.reject("E_PREVIEW_NONE", error?.localizedDescription ?? "no thumbnail")
          return
        }
        do {
          try FileManager.default.createDirectory(
            at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
          try data.write(to: out, options: .atomic)
          promise.resolve([
            "width": Double(image.size.width * image.scale),
            "height": Double(image.size.height * image.scale),
          ])
        } catch {
          promise.reject("E_PREVIEW_WRITE", error.localizedDescription)
        }
      }
    }

    // A PDF's page count (PDFKit), or nil when it cannot be opened.
    Function("pdfPageCount") { (fileUri: String) -> Int? in
      guard let file = URL(string: fileUri), let document = PDFDocument(url: file) else {
        return nil
      }
      return document.pageCount
    }
  }
}
