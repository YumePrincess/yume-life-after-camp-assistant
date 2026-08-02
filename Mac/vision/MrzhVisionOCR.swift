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

    var description: String {
        switch self {
        case .usage:
            return "Usage: mrzh-vision-ocr <image-path> [fast|accurate]"
        case .unreadableImage(let path):
            return "Unable to read image dimensions: \(path)"
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

func loadImage(at url: URL) throws -> CGImage {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw OCRFailure.unreadableImage(url.path)
    }
    return image
}

func effectiveRecognitionMode(_ requestedMode: String) -> String {
    let osVersion = ProcessInfo.processInfo.operatingSystemVersion
    // macOS 27 Vision currently traps inside SwiftNativeNSArray before a
    // `.fast` request returns. Apple's `.accurate` path uses the same public
    // text-recognition contract and completes a 1920×1200 HUD frame in well
    // under the Agent's one-second fallback cadence on Apple silicon.
    if requestedMode == "fast" && osVersion.majorVersion == 27 {
        return "accurate"
    }
    return requestedMode
}

func configureLegacyRequest(_ request: VNRecognizeTextRequest, recognitionMode: String) throws {
    request.recognitionLevel = recognitionMode == "fast" ? .fast : .accurate
    if recognitionMode != "fast" {
        let preferredLanguages = ["zh-Hans", "zh-Hant", "en-US"]
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
    try configureLegacyRequest(request, recognitionMode: recognitionMode)

    let handler = VNImageRequestHandler(url: imageURL, options: [:])
    try handler.perform([request])

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
    var request = RecognizeTextRequest()
    request.recognitionLevel = recognitionMode == "fast" ? .fast : .accurate
    if recognitionMode != "fast" {
        let preferredLanguages = ["zh-Hans", "zh-Hant", "en-US"]
            .map(Locale.Language.init(identifier:))
        let supportedLanguages = Set(request.supportedRecognitionLanguages)
        request.recognitionLanguages = preferredLanguages.filter(supportedLanguages.contains)
    }
    request.usesLanguageCorrection = false
    request.minimumTextHeightFraction = 0.008

    let image = try loadImage(at: imageURL)
    return try await request.perform(on: image).compactMap { observation in
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
            if #available(macOS 15.0, *) {
                observations = try await modernRecognize(
                    imageURL: imageURL,
                    dimensions: dimensions,
                    recognitionMode: recognitionMode
                )
            } else {
                observations = try legacyRecognize(
                    imageURL: imageURL,
                    dimensions: dimensions,
                    recognitionMode: recognitionMode
                )
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
