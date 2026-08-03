import CoreGraphics
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

func configureLegacyRequest(_ request: VNRecognizeTextRequest, recognitionMode: String) throws {
    if ProcessInfo.processInfo.operatingSystemVersion.majorVersion == 27 {
        // Explicitly select the oldest supported detector revision. macOS 27
        // crashes in the default/latest fast detector before returning any
        // observations; effectiveRecognitionMode routes the public fast mode
        // to this stable detector on that OS.
        request.revision = 1
    }
    request.recognitionLevel = recognitionMode == "fast" ? .fast : .accurate
    if recognitionMode != "fast" {
        let preferredLanguages = ["zh-Hans", "zh-Hant", "en-US", "ja-JP"]
        let supportedLanguages = try request.supportedRecognitionLanguages()
        request.recognitionLanguages = preferredLanguages.filter(supportedLanguages.contains)
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
    recognitionMode: String
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

    // Let Vision open the file itself. On macOS 27, going through a manually
    // decoded CGImage can make Vision fail while creating its internal pixel
    // buffer even though the PNG is valid and readable by ImageIO.
    let handler = VNImageRequestHandler(url: imageURL, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw OCRFailure.visionStageFailed(
            "legacy URL recognition",
            String(describing: error)
        )
    }

    return (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else {
            return nil
        }

        let box = observation.boundingBox
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

@available(macOS 15.0, *)
func modernRecognize(
    imageURL: URL,
    dimensions: (width: Int, height: Int),
    recognitionMode: String
) async throws -> [OCRObservation] {
    var request = RecognizeTextRequest(.revision3)
    request.recognitionLevel = recognitionMode == "fast" ? .fast : .accurate
    let osVersion = ProcessInfo.processInfo.operatingSystemVersion
    if recognitionMode != "fast" && osVersion.majorVersion != 27 {
        let preferredLanguages = ["zh-Hans", "zh-Hant", "en-US"]
            .map(Locale.Language.init(identifier:))
        let supportedLanguages = Set(request.supportedRecognitionLanguages)
        request.recognitionLanguages = preferredLanguages.filter(supportedLanguages.contains)
    }
    request.automaticallyDetectsLanguage = osVersion.majorVersion == 27
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
    return results.compactMap { observation in
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
            let observations: [OCRObservation]
            do {
                // Legacy Vision is the stable low-latency path for both modes
                // on macOS 26+. It avoids the macOS 27 revision-3 fast crash
                // and does not require CVPixelBuffer conversion.
                observations = try legacyRecognize(
                    imageURL: imageURL,
                    dimensions: dimensions,
                    recognitionMode: recognitionMode
                )
            } catch let legacyError {
                guard #available(macOS 15.0, *) else { throw legacyError }
                // Keep revision-3 as a guarded fallback for images the legacy
                // recognizer cannot decode (for example unusual PNG metadata).
                do {
                    observations = try await modernRecognize(
                        imageURL: imageURL,
                        dimensions: dimensions,
                        recognitionMode: recognitionMode == "fast" ? "accurate" : recognitionMode
                    )
                } catch let modernError {
                    throw OCRFailure.visionStageFailed(
                        "legacy and modern recognition",
                        "legacy=\(legacyError); modern=\(modernError)"
                    )
                }
            }

            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(observations)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
