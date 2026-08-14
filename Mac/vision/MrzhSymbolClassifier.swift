import CoreGraphics
import CoreImage
import CoreML
import Foundation
import ImageIO
import Vision

// Core ML is deliberately limited to glyph classification. It never decides
// which page to open, which button to click, or which record to write.
final class MrzhSymbolClassifier {
    enum State: CustomStringConvertible {
        case unavailable(String)
        case loaded(URL)

        var description: String {
            switch self {
            case .unavailable(let reason): return "unavailable:\(reason)"
            case .loaded(let url): return "loaded:\(url.path)"
            }
        }
    }

    private let model: VNCoreMLModel?
    let state: State

    init() {
        let candidates = Self.modelCandidates()
        for url in candidates where FileManager.default.fileExists(atPath: url.path) {
            do {
                let modelURL = try Self.compiledModelURL(for: url)
                let coreMLModel = try MLModel(contentsOf: modelURL)
                model = try VNCoreMLModel(for: coreMLModel)
                state = .loaded(url)
                return
            } catch {
                continue
            }
        }
        model = nil
        state = .unavailable(candidates.isEmpty ? "no_path" : "model_not_bundled")
    }

    func classify(
        observation: OCRObservation,
        image: CGImage,
        minimumConfidence: Float = 0.55
    ) -> String? {
        guard let model,
              let crop = Self.crop(image: image, observation: observation),
              let normalizedCrop = Self.normalizeContrast(crop)
        else {
            return nil
        }

        let request = VNCoreMLRequest(model: model)
        request.imageCropAndScaleOption = .scaleFit
        let handler = VNImageRequestHandler(cgImage: normalizedCrop, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        guard let result = request.results?.compactMap({ $0 as? VNClassificationObservation }).first else {
            return nil
        }
        guard result.confidence >= minimumConfidence else { return nil }
        return Self.canonicalGlyph(for: result.identifier)
    }

    func refine(
        candidate: VNRecognizedText,
        image: CGImage,
        dimensions: (width: Int, height: Int),
        lineBox: CGRect
    ) -> String {
        let source = candidate.string
        guard model != nil, source.count > 1 else { return source }
        var output = ""
        var stringIndex = source.startIndex
        while stringIndex < source.endIndex {
            let nextIndex = source.index(after: stringIndex)
            let character = source[stringIndex]
            let glyphText = String(character)
            let range = stringIndex..<nextIndex
            stringIndex = nextIndex

            let lineHasHanOrKana = Self.containsHanOrKana(source)
            let explicitSymbol = !lineHasHanOrKana && Self.isCandidateGlyph(glyphText)
            let isTrailingStarMisread = lineHasHanOrKana &&
                nextIndex == source.endIndex &&
                candidate.confidence < 0.45 &&
                Self.starMisreadCharacters.contains(glyphText)
            guard explicitSymbol || isTrailingStarMisread else {
                output.append(contentsOf: glyphText)
                continue
            }

            let directBox = isTrailingStarMisread
                ? nil
                : (try? candidate.boundingBox(for: range))?.boundingBox
            let normalizedBox: CGRect? = {
                if let directBox, !directBox.isNull, directBox.width > 0, directBox.height > 0 {
                    return directBox
                }
                guard isTrailingStarMisread,
                      !lineBox.isNull,
                      lineBox.width > 0,
                      lineBox.height > 0
                else { return nil }
                // Vision can merge a pair of decorative stars into the final
                // Han-looking token. Use the final visual cell as a stable
                // Core ML crop when the per-character range has no box.
                // The merged token is commonly two adjacent stars while
                // Vision exposes one trailing character. Reserve one extra
                // visual cell so the crop is centered on the rightmost star.
                let cellWidth = lineBox.width / CGFloat(source.count + 1) * 0.72
                return CGRect(
                    x: lineBox.maxX - cellWidth,
                    y: lineBox.minY,
                    width: cellWidth,
                    height: lineBox.height
                )
            }()
            guard let normalizedBox else {
                output.append(contentsOf: glyphText)
                continue
            }

            let observation = OCRObservation(
                text: glyphText,
                confidence: candidate.confidence,
                x: Int((normalizedBox.minX * Double(dimensions.width)).rounded()),
                y: Int(((1 - normalizedBox.maxY) * Double(dimensions.height)).rounded()),
                width: Int((normalizedBox.width * Double(dimensions.width)).rounded()),
                height: Int((normalizedBox.height * Double(dimensions.height)).rounded())
            )
            let minimumConfidence: Float = 0.55
            if let classified = classify(
                observation: observation,
                image: image,
                minimumConfidence: minimumConfidence
            ), (!isTrailingStarMisread || Self.decorativeStars.contains(classified)) {
                output.append(contentsOf: classified)
            } else {
                output.append(contentsOf: glyphText)
            }
        }
        return output
    }

    func apply(to observations: [OCRObservation], imageURL: URL) -> [OCRObservation] {
        guard model != nil, let image = Self.loadImage(at: imageURL) else {
            return observations
        }
        return observations.map { observation in
            guard Self.isCandidateGlyph(observation.text) else {
                return observation
            }
            guard let glyph = classify(observation: observation, image: image) else {
                return observation
            }
            return OCRObservation(
                text: glyph,
                confidence: observation.confidence,
                x: observation.x,
                y: observation.y,
                width: observation.width,
                height: observation.height
            )
        }
    }

    private static func modelCandidates() -> [URL] {
        var candidates: [URL] = []
        if let configured = ProcessInfo.processInfo.environment["MRZH_SYMBOL_CLASSIFIER_MODEL"],
           !configured.isEmpty {
            candidates.append(URL(fileURLWithPath: configured))
        }
        let executableDirectory = URL(fileURLWithPath: CommandLine.arguments[0])
            .deletingLastPathComponent()
        candidates.append(executableDirectory.appendingPathComponent("SymbolClassifier.mlmodelc"))
        candidates.append(executableDirectory.appendingPathComponent("SymbolClassifier.mlmodel"))
        let sourceVisionDirectory = executableDirectory
            .deletingLastPathComponent()
            .appendingPathComponent("vision", isDirectory: true)
        candidates.append(sourceVisionDirectory.appendingPathComponent("SymbolClassifier.mlmodelc"))
        candidates.append(sourceVisionDirectory.appendingPathComponent("SymbolClassifier.mlmodel"))
        return candidates
    }

    private static func compiledModelURL(for url: URL) throws -> URL {
        guard url.pathExtension == "mlmodel" else { return url }
        return try MLModel.compileModel(at: url)
    }

    private static func loadImage(at url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    private static func crop(image: CGImage, observation: OCRObservation) -> CGImage? {
        let rect = CGRect(
            x: observation.x,
            y: image.height - observation.y - observation.height,
            width: observation.width,
            height: observation.height
        ).intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !rect.isNull, rect.width >= 2, rect.height >= 2 else { return nil }
        return image.cropping(to: rect.integral)
    }

    private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    private static func normalizeContrast(_ image: CGImage) -> CGImage? {
        // Training samples are black glyphs on white. The game renders white
        // glyphs on a dark textured background, so invert before Core ML sees
        // the crop. Vision remains the source of the text boxes and spelling;
        // this step only makes the glyph classifier color-invariant.
        let input = CIImage(cgImage: image)
        let inverted = input.applyingFilter("CIColorInvert")
        return ciContext.createCGImage(inverted, from: inverted.extent)
    }

    private static func isCandidateGlyph(_ value: String) -> Bool {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.unicodeScalars.count == 1 else { return false }
        guard let scalar = text.unicodeScalars.first else { return false }
        // Vision is already the authoritative recognizer for Chinese and
        // Latin text. Core ML is only allowed to refine punctuation/symbol
        // glyphs (and the explicitly requested A look-alike).
        if scalar.value == 0x41 || scalar.value == 0x430 { return true }
        if commonGlyphScalars.contains(scalar.value) { return true }
        return CharacterSet.punctuationCharacters.contains(scalar) ||
            CharacterSet.symbols.contains(scalar)
    }

    private static func containsHanOrKana(_ value: String) -> Bool {
        value.unicodeScalars.contains { scalar in
            (0x3040...0x30FF).contains(scalar.value) ||
                (0x3400...0x9FFF).contains(scalar.value)
        }
    }

    private static let starMisreadCharacters: Set<String> = ["卒", "子"]
    private static let decorativeStars: Set<String> = ["★", "☆", "✦", "✧", "✰", "✯", "⋆"]

    private static let commonGlyphScalars: Set<UInt32> = Set(
        "☪⋆✯⛈•ᴗᴥ◔ᕱ⸝·ʕ˃⌓°꒰ꀾ꒱˒̼˙ϖ⚝☁♡・☂☄ᵕ₂₀ᐝ☹＋＝♪♬ℂℍℕℙℚℝℤ㋛⁼³₌₃ʚɞღ౪งคεïз✐❆➳☽ฅଲଇଉକ✡☃⚚☼✧❁ෆ๓☾✉Ⱉ⚇⌔ﻌᐢ₍₎◡ᵔ´ᆺ✦⁺∞ಥᖗᖘ❛‿˂੧੭◍ㅅつ⊂Ծ‸乁૮ꈔꈊ⍤⃝⚆⍢⍨∵⍥⍩⃜ᗦ↞◃ᙏ☻❤✈ᯤ╭╰◜◝͡◟◞͜✰✩✪✫✬✭✮♥♣♧♦✓✔→←↑↓➜☞☜✿❀❈ꕤ୨୧☀☇☈☉☊☋☌☍♠♤「」『』【】《》〈〉〔〕⟦⟧〚〛⟨⟩".unicodeScalars.map(\.value)
    )

    private static func canonicalGlyph(for identifier: String) -> String? {
        let normalized = identifier
            .uppercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_")
        switch normalized {
        case "OPEN_BRACKET", "CLASS_OPEN_BRACKET", "U300C": return "「"
        case "CLOSE_BRACKET", "CLASS_CLOSE_BRACKET", "U300D": return "」"
        case "OPEN_DOUBLE_BRACKET", "CLASS_OPEN_DOUBLE_BRACKET": return "『"
        case "CLOSE_DOUBLE_BRACKET", "CLASS_CLOSE_DOUBLE_BRACKET": return "』"
        case "BLACK_SPADE", "CLASS_BLACK_SPADE", "U2660": return "♠"
        case "WHITE_SPADE", "CLASS_WHITE_SPADE", "U2664": return "♤"
        case "LATIN_A", "CLASS_LATIN_A": return "A"
        case "CYRILLIC_A", "CLASS_CYRILLIC_A": return "A"
        case "OTHER_SYMBOL", "UNKNOWN", "CLASS_OTHER_SYMBOL": return nil
        default:
            if normalized.hasPrefix("GLYPH_"),
               let value = UInt32(normalized.dropFirst("GLYPH_".count), radix: 16),
               let scalar = UnicodeScalar(value) {
                return String(scalar)
            }
            let scalarCount = identifier.unicodeScalars.count
            return scalarCount == 1 ? identifier : nil
        }
    }
}
