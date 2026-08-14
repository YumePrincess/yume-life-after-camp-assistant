import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import Vision

struct OCRObservation: Codable {
    let text: String
    let confidence: Float
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

enum OCRFailure: Error, CustomStringConvertible {
    case usage
    case unreadableImage(String)
    case visionStageFailed(String, String)

    var description: String {
        switch self {
        case .usage:
            return "Usage: mrzh-vision-ocr <image-path> [fast|accurate]"
        case .unreadableImage(let path):
            return "Unable to read image dimensions: \(path)"
        case .visionStageFailed(let stage, let detail):
            return "Vision failed during \(stage): \(detail)"
        }
    }
}

func imageDimensions(at url: URL) throws -> (width: Int, height: Int) {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? Int,
        let height = properties[kCGImagePropertyPixelHeight] as? Int
    else {
        throw OCRFailure.unreadableImage(url.path)
    }

    return (width, height)
}

func effectiveRecognitionMode(_ requestedMode: String) -> String {
    // macOS 27's Vision `.fast` detector traps in SwiftNativeNSArray with
    // "Array index out of range". Preserve the fast contract at the Agent
    // boundary, but route it to the warmed stable detector on this OS.
    if requestedMode == "fast" &&
        ProcessInfo.processInfo.operatingSystemVersion.majorVersion == 27 {
        return "accurate"
    }
    return requestedMode == "fast" ? "fast" : "accurate"
}

func symbolOnlyFallbackRecognize(
    imageURL: URL,
    dimensions: (width: Int, height: Int)
) -> [OCRObservation] {
    guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { return [] }
    let input = CIImage(cgImage: image)
    let grayscale = input.applyingFilter(
        "CIColorControls",
        parameters: [
            kCIInputSaturationKey: 0,
            kCIInputContrastKey: 1.7
        ]
    )
    let prepared = grayscale.applyingFilter("CIColorInvert")
    let context = CIContext(options: [.useSoftwareRenderer: false])
    guard let preparedImage = context.createCGImage(prepared, from: prepared.extent)
    else { return [] }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.003
    if let languages = try? request.supportedRecognitionLanguages(),
       languages.contains("en-US") {
        request.recognitionLanguages = ["en-US"]
    }
    let handler = VNImageRequestHandler(cgImage: preparedImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return []
    }
    return (request.results ?? []).compactMap { observation -> OCRObservation? in
        guard let candidate = observation.topCandidates(1).first,
              isSymbolOnly(candidate.string)
        else { return nil }
        let box = observation.boundingBox
        return OCRObservation(
            text: candidate.string,
            confidence: candidate.confidence,
            x: Int((box.minX * Double(dimensions.width)).rounded()),
            y: Int(((1 - box.maxY) * Double(dimensions.height)).rounded()),
            width: Int((box.width * Double(dimensions.width)).rounded()),
            height: Int((box.height * Double(dimensions.height)).rounded())
        )
    }
}

func isSymbolOnly(_ value: String) -> Bool {
    let characters = Array(value)
    guard !characters.isEmpty else { return false }
    return !characters.contains { character in
        character.unicodeScalars.contains { scalar in
            CharacterSet.letters.contains(scalar) ||
                CharacterSet.decimalDigits.contains(scalar) ||
                (0x3400...0x9FFF).contains(scalar.value) ||
                (0x3040...0x30FF).contains(scalar.value)
        }
    }
}

func configureLegacyRequest(_ request: VNRecognizeTextRequest, recognitionMode: String) throws {
    request.recognitionLevel = recognitionMode == "fast" ? .fast : .accurate
    // Always constrain the recognizer to the game's languages. Leaving this
    // unset makes macOS 27's compatibility path auto-detect Latin/Cyrillic
    // glyphs for Chinese HUD text and return plausible-looking gibberish.
    let preferredLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP"]
    let supportedLanguages = try request.supportedRecognitionLanguages()
    let selectedLanguages = preferredLanguages.filter(supportedLanguages.contains)
    // An OS language pack can report no intersection while Vision itself is
    // still usable. Assigning an empty array makes the request fail with the
    // opaque nilError, so leave the recognizer's default language set in that
    // case and let the downstream visual normalizer handle spelling.
    if !selectedLanguages.isEmpty {
        request.recognitionLanguages = selectedLanguages
    }
    // Game UI consists of short labels and numbers. Language correction is
    // expensive on full-resolution emulator frames and can stall for tens of
    // seconds without improving these tokens.
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.008
}

func legacyRecognize(
    imageURL: URL,
    dimensions: (width: Int, height: Int),
    recognitionMode: String,
    symbolClassifier: MrzhSymbolClassifier?
) throws -> [OCRObservation] {
    let request = VNRecognizeTextRequest()
    do {
        try configureLegacyRequest(request, recognitionMode: recognitionMode)
    } catch {
        throw OCRFailure.visionStageFailed(
            "legacy language configuration",
            String(describing: error)
        )
    }

    let image = CGImageSourceCreateWithURL(imageURL as CFURL, nil).flatMap {
        CGImageSourceCreateImageAtIndex($0, 0, nil)
    }
    guard let image else {
        throw OCRFailure.unreadableImage(imageURL.path)
    }

    // Prefer the URL handler on macOS 27, but retry the exact same decoded
    // image when the URL-backed Vision bridge returns nilError. Some MuMu
    // screenshots carry PNG metadata that the bridge rejects while ImageIO
    // can still decode safely. Keeping this retry inside the OCR binary makes
    // Agent scans and diagnostic replays use the same deterministic path.
    do {
        try VNImageRequestHandler(url: imageURL, options: [:]).perform([request])
    } catch let urlError {
        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        } catch let cgError {
            throw OCRFailure.visionStageFailed(
                "legacy URL/CGImage recognition",
                "url=\(urlError); cgImage=\(cgError)"
            )
        }
    }

    return (request.results ?? []).compactMap { observation -> OCRObservation? in
        guard let candidate = observation.topCandidates(1).first else {
            return nil
        }

        let box = observation.boundingBox
        let x = Int((box.minX * Double(dimensions.width)).rounded())
        let width = Int((box.width * Double(dimensions.width)).rounded())
        let height = Int((box.height * Double(dimensions.height)).rounded())
        let y = Int(((1 - box.maxY) * Double(dimensions.height)).rounded())

        let text = symbolClassifier?.refine(
            candidate: candidate,
            image: image,
            dimensions: dimensions,
            lineBox: box
        ) ?? candidate.string

        return OCRObservation(
            text: text,
            confidence: candidate.confidence,
            x: x,
            y: y,
            width: width,
            height: height
        )
    }
}

@available(macOS 15.0, *)
func modernRecognize(
    imageURL: URL,
    dimensions: (width: Int, height: Int),
    recognitionMode: String,
    symbolClassifier: MrzhSymbolClassifier?
) async throws -> [OCRObservation] {
    var request = RecognizeTextRequest(.revision3)
    request.recognitionLevel = recognitionMode == "fast" ? .fast : .accurate
    let preferredLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP"]
        .map(Locale.Language.init(identifier:))
    let supportedLanguages = Set(request.supportedRecognitionLanguages)
    request.recognitionLanguages = preferredLanguages.filter(supportedLanguages.contains)
    request.automaticallyDetectsLanguage = false
    request.usesLanguageCorrection = false
    request.minimumTextHeightFraction = 0.008

    let results: [RecognizedTextObservation]
    do {
        // Vision's Swift API owns image decoding and pixel-buffer creation for
        // URL input. This is important on macOS 27: manually creating a
        // 32BGRA CVPixelBuffer can fail even for valid emulator screenshots.
        results = try await request.perform(on: imageURL, orientation: .up)
    } catch {
        throw OCRFailure.visionStageFailed("modern URL recognition", String(describing: error))
    }
    return results.compactMap { observation -> OCRObservation? in
        guard let candidate = observation.topCandidates(1).first else {
            return nil
        }
        let box = observation.boundingBox.cgRect
        let x = Int((box.minX * Double(dimensions.width)).rounded())
        let width = Int((box.width * Double(dimensions.width)).rounded())
        let height = Int((box.height * Double(dimensions.height)).rounded())
        let y = Int(((1 - box.maxY) * Double(dimensions.height)).rounded())

        return OCRObservation(
            text: candidate.string,
            confidence: candidate.confidence,
            x: x,
            y: y,
            width: width,
            height: height
        )
    }
}

@main
struct MrzhVisionOCR {
    static func main() async {
        do {
            guard CommandLine.arguments.count >= 2 else {
                throw OCRFailure.usage
            }

            let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
            let dimensions = try imageDimensions(at: imageURL)
            let requestedMode = CommandLine.arguments.count >= 3
                ? CommandLine.arguments[2]
                : "accurate"
            let recognitionMode = effectiveRecognitionMode(requestedMode)
            let symbolClassifier = MrzhSymbolClassifier()
            var observations: [OCRObservation]
            do {
                // Legacy Vision is the stable low-latency path for both modes
                // on macOS 26+. It avoids the macOS 27 revision-3 fast crash
                // and does not require CVPixelBuffer conversion.
                observations = try legacyRecognize(
                    imageURL: imageURL,
                    dimensions: dimensions,
                    recognitionMode: recognitionMode,
                    symbolClassifier: symbolClassifier
                )
            } catch let legacyError {
                guard #available(macOS 15.0, *) else { throw legacyError }
                // Keep revision-3 as a guarded fallback for images the legacy
                // recognizer cannot decode (for example unusual PNG metadata).
                do {
                    observations = try await modernRecognize(
                        imageURL: imageURL,
                        dimensions: dimensions,
                        recognitionMode: recognitionMode == "fast" ? "accurate" : recognitionMode,
                        symbolClassifier: symbolClassifier
                    )
                } catch let modernError {
                    throw OCRFailure.visionStageFailed(
                        "legacy and modern recognition",
                        "legacy=\(legacyError); modern=\(modernError)"
                    )
                }
            }

            observations.append(contentsOf: symbolClassifier.recoverUnrecognizedSymbols(
                from: imageURL,
                dimensions: dimensions,
                existing: observations
            ))
            let classifiedObservations = symbolClassifier.apply(
                to: observations,
                imageURL: imageURL
            )
            FileHandle.standardError.write(
                Data("symbol-classifier=\(symbolClassifier.state)\n".utf8)
            )

            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(classifiedObservations)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}

func observationsOverlap(_ left: OCRObservation, _ right: OCRObservation) -> Bool {
    let leftRect = CGRect(
        x: left.x,
        y: left.y,
        width: left.width,
        height: left.height
    )
    let rightRect = CGRect(
        x: right.x,
        y: right.y,
        width: right.width,
        height: right.height
    )
    let intersection = leftRect.intersection(rightRect)
    guard !intersection.isNull else { return false }
    let smallerArea = min(leftRect.width * leftRect.height, rightRect.width * rightRect.height)
    return smallerArea > 0 &&
        (intersection.width * intersection.height) / smallerArea >= 0.2
}
