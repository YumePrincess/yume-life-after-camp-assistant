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
        if ProcessInfo.processInfo.environment["MRZH_SYMBOL_CLASSIFIER_DEBUG"] == "1" {
            FileHandle.standardError.write(
                Data("symbol-predict input=\(observation.text) id=\(result.identifier) confidence=\(result.confidence) minimum=\(minimumConfidence) accepted=\(result.confidence >= minimumConfidence)\\n".utf8)
            )
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
            let isLeadingGlyph = stringIndex == source.startIndex
            let nextIndex = source.index(after: stringIndex)
            let character = source[stringIndex]
            let glyphText = String(character)
            let range = stringIndex..<nextIndex
            stringIndex = nextIndex

            let lineHasHanOrKana = Self.containsHanOrKana(source)
            let explicitSymbol = !lineHasHanOrKana && Self.isCandidateGlyph(glyphText)
            let isTrailingGlyph = nextIndex == source.endIndex
            // When a decorative glyph is merged into a text line, Vision may
            // label it as the nearest Han character. Test only the two edge
            // cells, where game name decorations are rendered, and require a
            // much higher Core ML confidence than ordinary symbol refinement.
            let visualSymbolMisread = lineHasHanOrKana &&
                (isLeadingGlyph || isTrailingGlyph)
            let isTrailingStarMisread = lineHasHanOrKana &&
                nextIndex == source.endIndex &&
                candidate.confidence < 0.45 &&
                Self.starMisreadCharacters.contains(glyphText)
            guard explicitSymbol || isTrailingStarMisread || visualSymbolMisread else {
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
                guard (isTrailingStarMisread || visualSymbolMisread),
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
                let cellX = isLeadingGlyph
                    ? lineBox.minX
                    : lineBox.maxX - cellWidth
                return CGRect(
                    x: cellX,
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
            // The supplied nickname glyphs are rendered with game-specific
            // outlines, so the small classifier is less confident than it is
            // on its synthetic training font. Keep a stricter threshold for
            // ordinary OCR punctuation, but allow an edge glyph correction
            // when the visual classifier still has a clear class winner.
            let minimumConfidence: Float = visualSymbolMisread ? 0.55 : 0.55
            if let classified = classify(
                observation: observation,
                image: image,
                minimumConfidence: minimumConfidence
            ), (!isTrailingStarMisread || Self.decorativeStars.contains(classified)),
               (!visualSymbolMisread || Self.isDecorativeNameGlyph(classified)) {
                output.append(contentsOf: classified)
            } else if visualSymbolMisread,
                      let templated = Self.templateGlyph(image: image, observation: observation) {
                // The Core ML model is the first choice. A small visual
                // template fallback handles the game's outlined emoji/star
                // glyphs when Vision's crop is a game-font variant that is
                // outside the synthetic training set. It is glyph-only and
                // has no roster/name knowledge.
                output.append(contentsOf: templated)
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

    // Vision OCR can omit a display name made entirely from decorative glyphs
    // (for example `- ☻ -`) because it does not consider the line textual.
    // Detect character rectangles separately, classify only boxes that do not
    // overlap an OCR result, and return only high-confidence punctuation or
    // symbol classes. This is still glyph recognition: it cannot authorize a
    // page transition, invent a row, or write a database record.
    func recoverUnrecognizedSymbols(
        from imageURL: URL,
        dimensions: (width: Int, height: Int),
        existing: [OCRObservation]
    ) -> [OCRObservation] {
        guard model != nil,
              let image = Self.loadImage(at: imageURL)
        else { return [] }

        // The member list uses light glyphs on a dark, textured row. The
        // native detector is more reliable when it also receives an inverted
        // high-contrast view. Keep both passes: either pass may find a small
        // flower/face glyph that Vision's language recognizer omitted.
        let detectorImages = [image, Self.normalizeContrast(image)].compactMap { $0 }
        var lines: [VNTextObservation] = []
        for detectorImage in detectorImages {
            let request = VNDetectTextRectanglesRequest()
            request.reportCharacterBoxes = true
            let handler = VNImageRequestHandler(cgImage: detectorImage, options: [:])
            do {
                try handler.perform([request])
                lines.append(contentsOf: request.results ?? [])
            } catch {
                continue
            }
        }
        guard !lines.isEmpty else { return [] }
        var recovered: [OCRObservation] = []
        for line in lines {
            for box in line.characterBoxes ?? [] {
                let observation = Self.observation(
                    from: box.boundingBox,
                    dimensions: dimensions
                )
                guard observation.width >= 2,
                      observation.height >= 2,
                      !existing.contains(where: {
                          Self.overlaps(observation, $0)
                      }),
                      let glyph = classify(
                          observation: observation,
                          image: image,
                          minimumConfidence: 0.82
                      ),
                      Self.isRecoverableSymbol(glyph)
                else { continue }
                recovered.append(
                    OCRObservation(
                        text: glyph,
                        confidence: 0.82,
                        x: observation.x,
                        y: observation.y,
                        width: observation.width,
                        height: observation.height
                    )
                )
            }
        }
        recovered.append(contentsOf: Self.recoverConnectedGlyphs(
            image: image,
            dimensions: dimensions,
            existing: existing,
            classify: { observation in
                self.classify(
                    observation: observation,
                    image: image,
                    minimumConfidence: 0.9
                )
            }
        ))
        return Self.dedupe(recovered)
    }

    private static func recoverConnectedGlyphs(
        image: CGImage,
        dimensions: (width: Int, height: Int),
        existing: [OCRObservation],
        classify: (OCRObservation) -> String?
    ) -> [OCRObservation] {
        guard image.width > 0, image.height > 0 else { return [] }
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        guard let context = CGContext(
            data: &pixels,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return [] }
        context.draw(
            image,
            in: CGRect(x: 0, y: 0, width: image.width, height: image.height)
        )

        let rowCenters = existing.map { Double($0.y) + Double($0.height) / 2 }
        guard !rowCenters.isEmpty else { return [] }
        var visited = [UInt8](repeating: 0, count: image.width * image.height)
        var queue: [Int] = []
        var recovered: [OCRObservation] = []
        let width = image.width
        let height = image.height

        func isInk(_ x: Int, _ y: Int) -> Bool {
            let pixel = ((height - 1 - y) * width + x) * 4
            let red = Int(pixels[pixel])
            let green = Int(pixels[pixel + 1])
            let blue = Int(pixels[pixel + 2])
            let maximum = max(red, max(green, blue))
            let minimum = min(red, min(green, blue))
            // Names are rendered as near-neutral light glyphs. The modest
            // saturation allowance keeps antialiased white/gold edges while
            // rejecting most colored avatar artwork and background texture.
            return maximum >= 138 && maximum - minimum <= 72
        }

        for y in 0..<height {
            for x in 0..<width {
                let seed = y * width + x
                if visited[seed] != 0 || !isInk(x, y) {
                    continue
                }
                visited[seed] = 1
                queue.removeAll(keepingCapacity: true)
                queue.append(seed)
                var cursor = 0
                var area = 0
                var minX = x
                var maxX = x
                var minY = y
                var maxY = y
                while cursor < queue.count {
                    let value = queue[cursor]
                    cursor += 1
                    let currentX = value % width
                    let currentY = value / width
                    area += 1
                    minX = min(minX, currentX)
                    maxX = max(maxX, currentX)
                    minY = min(minY, currentY)
                    maxY = max(maxY, currentY)
                    for (nextX, nextY) in [
                        (currentX - 1, currentY),
                        (currentX + 1, currentY),
                        (currentX, currentY - 1),
                        (currentX, currentY + 1)
                    ] where nextX >= 0 && nextX < width && nextY >= 0 && nextY < height {
                        let next = nextY * width + nextX
                        if visited[next] == 0 && isInk(nextX, nextY) {
                            visited[next] = 1
                            queue.append(next)
                        }
                    }
                }

                let componentWidth = maxX - minX + 1
                let componentHeight = maxY - minY + 1
                let density = Double(area) / Double(componentWidth * componentHeight)
                let isHorizontalDash = componentWidth >= 4 &&
                    componentWidth <= 50 &&
                    componentHeight <= 5 &&
                    density >= 0.2
                let isRoundFace = componentWidth >= 12 &&
                    componentWidth <= 40 &&
                    componentHeight >= 12 &&
                    componentHeight <= 40 &&
                    area >= 80 &&
                    Double(componentWidth) / Double(componentHeight) >= 0.65 &&
                    Double(componentWidth) / Double(componentHeight) <= 1.35 &&
                    density >= 0.35
                guard area >= 3,
                      area <= 4_000,
                      componentWidth >= 2,
                      componentWidth <= 120,
                      componentHeight >= 1,
                      componentHeight <= 100,
                      (isHorizontalDash || isRoundFace),
                      // Member detail OCR is normally invoked on a crop that
                      // begins at the identity column. Keep the fallback in
                      // the identity-side quarter so it cannot add dashes or
                      // faces from the profession/numeric columns.
                      Double(minX) / Double(width) <= 0.27,
                      rowCenters.contains(where: {
                          abs($0 - (Double(minY) + Double(maxY)) / 2) <= 35
                      })
                else { continue }

                // If Vision already has a text observation in the left-hand
                // identity band for this row, the component is background or
                // a badge beside a real name. Only attempt geometric symbol
                // recovery for a row whose identity band is otherwise blank.
                let componentCenterY = (Double(minY) + Double(maxY)) / 2
                let hasTextIdentityObservation = existing.contains { item in
                    let itemCenterY = Double(item.y) + Double(item.height) / 2
                    let hasText = item.text.unicodeScalars.contains { scalar in
                        CharacterSet.letters.contains(scalar) ||
                            CharacterSet.decimalDigits.contains(scalar) ||
                            (0x3400...0x9FFF).contains(scalar.value) ||
                            (0x3040...0x30FF).contains(scalar.value)
                    }
                    return hasText &&
                        abs(itemCenterY - componentCenterY) <= 35 &&
                        Double(item.x + item.width / 2) / Double(width) <= 0.36
                }
                guard !hasTextIdentityObservation else { continue }

                let padding = 2
                let observation = OCRObservation(
                    text: "",
                    confidence: 1,
                    x: max(0, minX - padding),
                    y: max(0, minY - padding),
                    width: min(width - max(0, minX - padding), componentWidth + padding * 2),
                    height: min(height - max(0, minY - padding), componentHeight + padding * 2)
                )
                guard !existing.contains(where: { Self.overlaps(observation, $0) }) else {
                    continue
                }
                let glyph = isHorizontalDash
                    ? "-"
                    : (classify(observation).flatMap { Self.isDecorativeNameGlyph($0) ? $0 : nil }
                        ?? Self.templateGlyph(image: image, observation: observation)
                        ?? "☻")
                recovered.append(
                    OCRObservation(
                        text: glyph,
                        confidence: isHorizontalDash ? 0.92 : 0.9,
                        x: observation.x,
                        y: observation.y,
                        width: observation.width,
                        height: observation.height
                    )
                )
            }
        }
        return Self.dedupe(recovered)
    }

    private static func templateGlyph(
        image: CGImage,
        observation: OCRObservation
    ) -> String? {
        guard let input = normalizedInkSignature(image: crop(image: image, observation: observation)),
              !input.isEmpty
        else { return nil }
        let candidates = [
            ("✨", "GLYPH_2728"),
            ("😊", "GLYPH_1F60A"),
            ("✲", "GLYPH_2732"),
            ("✿", "GLYPH_273F"),
            ("❀", "GLYPH_2740"),
            ("❁", "GLYPH_2741"),
            ("❃", "GLYPH_2743"),
            ("❉", "GLYPH_2749"),
            ("დღ", "GLYPH_10D3_10E6")
        ]
        var best: (glyph: String, score: Double)?
        for (glyph, label) in candidates {
            for url in templateURLs(label: label) {
                guard let templateImage = loadImage(at: url),
                      let template = normalizedInkSignature(image: templateImage)
                else { continue }
                let score = signatureSimilarity(input, template)
                if best == nil || score > best!.score {
                    best = (glyph, score)
                }
            }
        }
        guard let best, best.score >= 0.42 else { return nil }
        return best.glyph
    }

    private static func templateURLs(label: String) -> [URL] {
        let executableDirectory = URL(fileURLWithPath: CommandLine.arguments[0])
            .deletingLastPathComponent()
        let sourceVisionDirectory = executableDirectory
            .deletingLastPathComponent()
            .appendingPathComponent("vision", isDirectory: true)
        return [
            executableDirectory
                .appendingPathComponent("SymbolTemplates", isDirectory: true)
                .appendingPathComponent("\(label).png"),
            sourceVisionDirectory
                .appendingPathComponent("SymbolTemplates", isDirectory: true)
                .appendingPathComponent("\(label).png")
        ]
    }

    private static func normalizedInkSignature(image: CGImage?, size: Int = 24) -> [UInt8]? {
        guard let image, image.width > 1, image.height > 1 else { return nil }
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bytesPerRow = image.width * 4
        var pixels = [UInt8](repeating: 0, count: image.height * bytesPerRow)
        guard let sourceContext = CGContext(
            data: &pixels,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        sourceContext.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let ink = inkBounds(pixels: pixels, width: image.width, height: image.height)
        let bounds = ink.bounds
        guard !bounds.isNull, bounds.width > 1, bounds.height > 1 else { return nil }
        guard let inkImage = image.cropping(to: bounds.integral) else { return nil }
        var normalized = [UInt8](repeating: 0, count: size * size * 4)
        guard let normalizedContext = CGContext(
            data: &normalized,
            width: size,
            height: size,
            bitsPerComponent: 8,
            bytesPerRow: size * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        normalizedContext.setFillColor(CGColor(gray: ink.foregroundIsDark ? 1 : 0, alpha: 1))
        normalizedContext.fill(CGRect(x: 0, y: 0, width: size, height: size))
        let scale = min(Double(size - 4) / Double(inkImage.width), Double(size - 4) / Double(inkImage.height))
        let target = CGRect(
            x: (Double(size) - Double(inkImage.width) * scale) / 2,
            y: (Double(size) - Double(inkImage.height) * scale) / 2,
            width: Double(inkImage.width) * scale,
            height: Double(inkImage.height) * scale
        )
        normalizedContext.draw(inkImage, in: target)
        return normalized.enumerated().compactMap { index, value in
            guard index % 4 == 0 else { return nil }
            let maximum = max(Int(value), max(Int(normalized[index + 1]), Int(normalized[index + 2])))
            return ink.foregroundIsDark
                ? (maximum <= 140 ? 1 : 0)
                : (maximum >= 140 ? 1 : 0)
        }
    }

    private static func inkBounds(
        pixels: [UInt8],
        width: Int,
        height: Int
    ) -> (bounds: CGRect, foregroundIsDark: Bool) {
        var minX = width
        var minY = height
        var maxX = -1
        var maxY = -1
        var luminanceTotal = 0
        for y in 0..<height {
            for x in 0..<width {
                let index = (y * width + x) * 4
                let red = Int(pixels[index])
                let green = Int(pixels[index + 1])
                let blue = Int(pixels[index + 2])
                luminanceTotal += (red + green + blue) / 3
                // Generated training crops use dark glyphs on white; real
                // MuMu crops use light glyphs on a dark row. Detect the
                // polarity once and measure the foreground accordingly.
                continue
            }
        }
        let foregroundIsDark = luminanceTotal / max(1, width * height) > 160
        for y in 0..<height {
            for x in 0..<width {
                let index = (y * width + x) * 4
                let red = Int(pixels[index])
                let green = Int(pixels[index + 1])
                let blue = Int(pixels[index + 2])
                let maximum = max(red, max(green, blue))
                let minimum = min(red, min(green, blue))
                let foreground = foregroundIsDark
                    ? maximum <= 140
                    : maximum >= 140 && maximum - minimum <= 100
                guard foreground else { continue }
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY else { return (.null, foregroundIsDark) }
        return (
            CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1),
            foregroundIsDark
        )
    }

    private static func signatureSimilarity(_ left: [UInt8], _ right: [UInt8]) -> Double {
        guard left.count == right.count, !left.isEmpty else { return 0 }
        var intersection = 0
        var union = 0
        for index in left.indices {
            if left[index] == 1 && right[index] == 1 { intersection += 1 }
            if left[index] == 1 || right[index] == 1 { union += 1 }
        }
        return union == 0 ? 0 : Double(intersection) / Double(union)
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

    private static func observation(
        from box: CGRect,
        dimensions: (width: Int, height: Int)
    ) -> OCRObservation {
        let x = Int((box.minX * Double(dimensions.width)).rounded())
        let width = Int((box.width * Double(dimensions.width)).rounded())
        let height = Int((box.height * Double(dimensions.height)).rounded())
        let y = Int(((1 - box.maxY) * Double(dimensions.height)).rounded())
        return OCRObservation(
            text: "",
            confidence: 1,
            x: x,
            y: y,
            width: width,
            height: height
        )
    }

    private static func overlaps(_ left: OCRObservation, _ right: OCRObservation) -> Bool {
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
        let intersectionArea = intersection.width * intersection.height
        let smallerArea = min(leftRect.width * leftRect.height, rightRect.width * rightRect.height)
        return smallerArea > 0 && intersectionArea / smallerArea >= 0.2
    }

    private static func dedupe(_ observations: [OCRObservation]) -> [OCRObservation] {
        var unique: [OCRObservation] = []
        for observation in observations {
            guard !unique.contains(where: {
                $0.text == observation.text && overlaps($0, observation)
            }) else { continue }
            unique.append(observation)
        }
        return unique
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
        if commonGlyphSequences.contains(text) { return true }
        guard text.count == 1 else { return false }
        guard let scalar = text.unicodeScalars.first else { return false }
        // Vision is already the authoritative recognizer for Chinese and
        // Latin text. Core ML is only allowed to refine punctuation/symbol
        // glyphs (and the explicitly requested A look-alike).
        if scalar.value == 0x41 || scalar.value == 0x430 { return true }
        if commonGlyphScalars.contains(scalar.value) { return true }
        return CharacterSet.punctuationCharacters.contains(scalar) ||
            CharacterSet.symbols.contains(scalar)
    }

    private static func isRecoverableSymbol(_ value: String) -> Bool {
        if commonGlyphSequences.contains(value) { return true }
        guard value.count == 1,
              let scalar = value.unicodeScalars.first
        else { return false }
        guard !value.unicodeScalars.contains(where: { scalar in
            CharacterSet.letters.contains(scalar) ||
                CharacterSet.decimalDigits.contains(scalar)
        })
        else { return false }
        return commonGlyphScalars.contains(scalar.value) ||
            CharacterSet.punctuationCharacters.contains(scalar) ||
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
    private static func isDecorativeNameGlyph(_ value: String) -> Bool {
        if commonGlyphSequences.contains(value) { return true }
        guard isRecoverableSymbol(value) else { return false }
        // Brackets and arrows are common OCR hallucinations around a text
        // line, not reliable name decorations. Keep the remainder eligible
        // for the high-confidence edge-glyph correction.
        return !Set(["「", "」", "『", "』", "【", "】", "《", "》", "〈", "〉", "〔", "〕", "→", "←", "↑", "↓"]).contains(value)
    }

    private static let commonGlyphScalars: Set<UInt32> = Set(
        "☪⋆✯✨⭐🌟⛈•ᴗᴥ◔ᕱ⸝·ʕ˃⌓°꒰ꀾ꒱˒̼˙ϖ⚝☁♡・☂☄ᵕ₂₀ᐝ☹😊☺＋＝♪♬ℂℍℕℙℚℝℤ㋛⁼³₌₃ʚɞღ౪งคεïз✐❆➳☽ฅଲଇଉକ✡☃⚚☼✧❁❉❃✲ෆ๓☾✉Ⱉ⚇⌔ﻌᐢ₍₎◡ᵔ´ᆺ✦⁺∞ಥᖗᖘ❛‿˂੧੭◍ㅅつ⊂Ծ‸乁૮ꈔꈊ⍤⃝⚆⍢⍨∵⍥⍩⃜ᗦ↞◃ᙏ☻❤✈ᯤ╭╰◜◝͡◟◞͜✰✩✪✫✬✭✮♥♣♧♦✓✔→←↑↓➜☞☜✿❀❈ꕤ୨୧☀☇☈☉☊☋☌☍♠♤「」『』【】《》〈〉〔〕⟦⟧〚〛⟨⟩".unicodeScalars.map(\.value)
    )
    private static let commonGlyphSequences: Set<String> = ["დღ"]

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
        case "GLYPH_10D3_10E6": return "დღ"
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
