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

do {
    guard CommandLine.arguments.count >= 2 else {
        throw OCRFailure.usage
    }

    let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
    let dimensions = try imageDimensions(at: imageURL)
    let recognitionMode = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : "accurate"

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = recognitionMode == "fast" ? .fast : .accurate
    request.recognitionLanguages = recognitionMode == "fast"
        ? ["en-US"]
        : ["zh-Hans", "zh-Hant", "en-US"]
    // Game UI consists of short labels and numbers. Language correction is
    // expensive on full-resolution emulator frames and can stall for tens of
    // seconds without improving these tokens.
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.008

    let handler = VNImageRequestHandler(url: imageURL, options: [:])
    try handler.perform([request])

    let observations: [OCRObservation] = (request.results ?? []).compactMap { observation in
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

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(observations)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
