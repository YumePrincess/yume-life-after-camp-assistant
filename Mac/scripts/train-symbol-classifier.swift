import AppKit
import CoreGraphics
import CoreML
import CoreText
import CreateML
import Foundation
import ImageIO

struct GlyphClass {
    let label: String
    let glyphs: [String]
}

let outputDirectory = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "/private/tmp/yla-symbol-classifier")
let datasetDirectory = outputDirectory.appendingPathComponent("dataset", isDirectory: true)
let modelURL = outputDirectory.appendingPathComponent("SymbolClassifier.mlmodel")
let compiledURL = outputDirectory.appendingPathComponent("SymbolClassifier.mlmodelc", isDirectory: true)

let baseClasses = [
    GlyphClass(label: "OPEN_BRACKET", glyphs: ["「"]),
    GlyphClass(label: "CLOSE_BRACKET", glyphs: ["」"]),
    GlyphClass(label: "OPEN_DOUBLE_BRACKET", glyphs: ["『"]),
    GlyphClass(label: "CLOSE_DOUBLE_BRACKET", glyphs: ["』"]),
    GlyphClass(label: "WHITE_SPADE", glyphs: ["♤"]),
    GlyphClass(label: "BLACK_SPADE", glyphs: ["♠"]),
    GlyphClass(label: "OTHER_SYMBOL", glyphs: ["♣", "♥", "♦", "★", "☆", "◇", "※", "·", "~", "^", "#", "+", "="])
]

// Common nickname glyphs gathered from the supplied examples and the common
// Unicode nickname groups: stars/hearts, weather/astrology, music, arrows,
// geometric marks, brackets, and small decorative faces. Each glyph gets its
// own label so the classifier can preserve it instead of collapsing it into
// OTHER_SYMBOL.
let commonGlyphs = [
    "☪", "⋆", "✯", "⛈", "•", "ᴗ", "ᴥ", "◔", "ᕱ", "⸝", "·", "ʕ", "˃", "⌓", "°", "꒰", "ꀾ", "꒱", "˒", "̼", "˙", "ϖ", "⚝", "☁", "♡", "・", "☂", "☄", "ᵕ", "₂", "₀", "ᐝ", "☹", "＋", "＝", "♪", "♬", "ℂ", "ℍ", "ℕ", "ℙ", "ℚ", "ℝ", "ℤ", "㋛", "⁼", "³", "₌", "₃", "ʚ", "ɞ", "ღ", "౪", "ง", "ค", "ε", "ï", "з", "✐", "❆", "➳", "☽", "ฅ", "ଲ", "ଇ", "ଉ", "କ", "✡", "☃", "⚚", "☼", "✧", "☆", "❁", "ෆ", "๓", "☾", "✉", "Ⱉ", "⚇", "⌔", "ﻌ", "ᐢ", "₍", "₎", "◡", "ᵔ", "´", "ᆺ", "✦", "⁺", "∞", "ಥ", "ᖗ", "ᖘ", "❛", "‿", "˂", "੧", "੭", "◍", "ㅅ", "つ", "⊂", "Ծ", "‸", "乁", "૮", "ꈔ", "ꈊ", "⍤", "⃝", "⚆", "⍢", "⍨", "∵", "⍥", "⍩", "⃜", "ᗦ", "↞", "◃", "ᙏ", "☻", "❤", "✈", "ᯤ", "╭", "╰", "◜", "◝", "͡", "◟", "◞", "͜", "✰", "✩", "✪", "✫", "✬", "✭", "✮", "♥", "♣", "♧", "♦", "✓", "✔", "→", "←", "↑", "↓", "➜", "☞", "☜", "✿", "❀", "❈", "ꕤ", "୨", "୧", "☀", "☇", "☈", "☉", "☊", "☋", "☌", "☍", "♠", "♤", "「", "」", "『", "』", "【", "】", "《", "》", "〈", "〉", "〔", "〕", "⟦", "⟧", "〚", "〛", "⟨", "⟩"
]
let baseLabels = Set(baseClasses.flatMap(\.glyphs))
let classes = baseClasses + commonGlyphs
    .filter { $0.unicodeScalars.count == 1 && !baseLabels.contains($0) }
    .map { glyph in
        let codePoint = String(glyph.unicodeScalars.first!.value, radix: 16, uppercase: true)
        return GlyphClass(label: "GLYPH_\(codePoint)", glyphs: [glyph])
    }

let fontNames = [
    "PingFangSC-Regular",
    "PingFangTC-Regular",
    "HiraginoSansGB-W3",
    "STHeitiSC-Light",
    "ArialUnicodeMS",
    "AppleSymbols"
]
let canvasSize = 96

try? FileManager.default.removeItem(at: outputDirectory)
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

for glyphClass in classes {
    let glyphFontNames = fontNames.filter { fontName in
        supportsGlyph(glyphClass.glyphs[0], font: CTFontCreateWithName(fontName as CFString, 48, nil))
    }
    if glyphFontNames.isEmpty {
        print("skipped \(glyphClass.label): no installed font supports this glyph")
        continue
    }
    let classDirectory = datasetDirectory.appendingPathComponent(glyphClass.label, isDirectory: true)
    try FileManager.default.createDirectory(at: classDirectory, withIntermediateDirectories: true)
    var written = 0
    let samplesForClass = glyphClass.label.hasPrefix("GLYPH_") ? 24 : 80
    for index in 0..<samplesForClass {
        let glyph = glyphClass.glyphs[index % glyphClass.glyphs.count]
        let fontName = glyphFontNames[index % glyphFontNames.count]
        let font = CTFontCreateWithName(fontName as CFString, CGFloat(42 + (index % 10)), nil)
        let path = classDirectory.appendingPathComponent("sample-\(index).png")
        try writeGlyph(
            glyph,
            font: font,
            rotation: CGFloat((index % 7) - 3) * .pi / 180,
            offset: CGPoint(x: CGFloat((index % 5) - 2), y: CGFloat((index % 3) - 1)),
            to: path
        )
        written += 1
    }
    guard written >= (glyphClass.label.hasPrefix("GLYPH_") ? 12 : 20) else {
        throw NSError(domain: "SymbolClassifier", code: 1, userInfo: [NSLocalizedDescriptionKey: "Not enough glyph samples for \(glyphClass.label)"])
    }
    print("generated \(glyphClass.label): \(written)")
}

let dataSource = MLImageClassifier.DataSource.labeledDirectories(at: datasetDirectory)
let parameters = MLImageClassifier.ModelParameters(
    validation: .split(strategy: .automatic),
    maxIterations: 25,
    augmentation: [.crop, .blur]
)
let classifier = try MLImageClassifier(trainingData: dataSource, parameters: parameters)
try classifier.write(to: modelURL)
let compiled = try MLModel.compileModel(at: modelURL)
try? FileManager.default.removeItem(at: compiledURL)
try FileManager.default.copyItem(at: compiled, to: compiledURL)
print("wrote \(compiledURL.path)")

func supportsGlyph(_ text: String, font: CTFont) -> Bool {
    var characters = Array(text.utf16)
    var glyphs = Array(repeating: CGGlyph(), count: characters.count)
    return CTFontGetGlyphsForCharacters(font, &characters, &glyphs, characters.count) && glyphs.allSatisfy { $0 != 0 }
}

func writeGlyph(_ text: String, font: CTFont, rotation: CGFloat, offset: CGPoint, to url: URL) throws {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
    guard let context = CGContext(
        data: nil,
        width: canvasSize,
        height: canvasSize,
        bitsPerComponent: 8,
        bytesPerRow: canvasSize * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else { throw NSError(domain: "SymbolClassifier", code: 2) }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize))
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)
    ]))
    let bounds = CTLineGetBoundsWithOptions(line, [])
    context.saveGState()
    context.translateBy(x: CGFloat(canvasSize) / 2 + offset.x, y: CGFloat(canvasSize) / 2 + offset.y)
    context.rotate(by: rotation)
    context.textPosition = CGPoint(x: -bounds.midX, y: -bounds.midY)
    CTLineDraw(line, context)
    context.restoreGState()
    guard let image = context.makeImage() else { throw NSError(domain: "SymbolClassifier", code: 3) }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.png" as CFString, 1, nil) else {
        throw NSError(domain: "SymbolClassifier", code: 4)
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "SymbolClassifier", code: 5) }
    try data.write(to: url)
}
