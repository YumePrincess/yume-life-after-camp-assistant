import CoreGraphics
import CoreVideo
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
    case imageNormalizationFailed(String)
    case visionStageFailed(String, String)

    var description: String {
        switch self {
        case .usage:
            return "Usage: mrzh-vision-ocr <image-path> [fast|accurate]"
        case .unreadableImage(let path):
            return "Unable to read image dimensions: \(path)"
        case .imageNormalizationFailed(let path):
            return "Unable to normalize image pixels: \(path)"
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

func normalizedImage(at url: URL) throws -> CGImage {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let sourceImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw OCRFailure.unreadableImage(url.path)
    }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
        | CGImageAlphaInfo.premultipliedLast.rawValue
    guard let context = CGContext(
        data: nil,
        width: sourceImage.width,
        height: sourceImage.height,
        bitsPerComponent: 8,
        bytesPerRow: sourceImage.width * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        throw OCRFailure.imageNormalizationFailed(url.path)
    }

    context.interpolationQuality = .high
    context.draw(
        sourceImage,
        in: CGRect(x: 0, y: 0, width: sourceImage.width, height: sourceImage.height)
    )
    guard let normalized = context.makeImage() else {
        throw OCRFailure.imageNormalizationFailed(url.path)
    }
    return normalized
}

func normalizedPixelBuffer(at url: URL) throws -> CVPixelBuffer {
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let sourceImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw OCRFailure.unreadableImage(url.path)
    }

    let attributes: [CFString: Any] = [
        kCVPixelBufferCGImageCompatibilityKey: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey: true
    ]
    var optionalBuffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
        kCFAllocatorDefault,
        sourceImage.width,
        sourceImage.height,
        kCVPixelFormatType_32BGRA,
        attributes as CFDictionary,
        &optionalBuffer
    )
    guard status == kCVReturnSuccess, let pixelBuffer = optionalBuffer else {
        throw OCRFailure.imageNormalizationFailed(
            "\(url.path) (CVPixelBufferCreate status \(status))"
        )
    }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
    guard
        let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer),
        let context = CGContext(
            data: baseAddress,
            width: sourceImage.width,
            height: sourceImage.height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue
                | CGImageAlphaInfo.premultipliedFirst.rawValue
        )
    else {
        throw OCRFailure.imageNormalizationFailed(url.path)
    }
    context.interpolationQuality = .high
    context.draw(
        sourceImage,
        in: CGRect(x: 0, y: 0, width: sourceImage.width, height: sourceImage.height)
    )
    return pixelBuffer
}

func effectiveRecognitionMode(_ requestedMode: String) -> String {
    requestedMode == "fast" ? "fast" : "accurate"
}

func configureLegacyRequest(_ request: VNRecognizeTextRequest, recognitionMode: String) throws {
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

    let image = try normalizedImage(at: imageURL)
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    do {
        try handler.perform([request])
    } catch {
        throw OCRFailure.visionStageFailed(
            "legacy normalized-image recognition",
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

    // macOS 27 can reject a PNG or CGImage while creating Vision's internal
    // CVPixelBuffer. Supply a known 32BGRA buffer directly.
    let pixelBuffer = try normalizedPixelBuffer(at: imageURL)
    let results: [RecognizedTextObservation]
    do {
        results = try await request.perform(on: pixelBuffer, orientation: .up)
    } catch {
        throw OCRFailure.visionStageFailed(
            "modern normalized-pixel-buffer recognition",
            String(describing: error)
        )
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
