import CoreGraphics
import Foundation
import ImageIO

struct ProbeResult: Codable {
    let x: Int
    let y: Int
    let meanRed: Double
    let meanGreen: Double
    let meanBlue: Double
    let meanSaturation: Double
    let luminanceDeviation: Double
}

func loadRGBA(path: String) throws -> (pixels: [UInt8], width: Int, height: Int) {
    let url = URL(fileURLWithPath: path)
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw NSError(domain: "MrzhPixelProbe", code: 1)
    }
    let width = image.width
    let height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard
        let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    else {
        throw NSError(domain: "MrzhPixelProbe", code: 2)
    }
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return (pixels, width, height)
}

func probe(
    pixels: [UInt8],
    width: Int,
    height: Int,
    x: Int,
    y: Int,
    radius: Int
) -> ProbeResult {
    let minX = max(0, x - radius)
    let maxX = min(width - 1, x + radius)
    let minY = max(0, y - radius)
    let maxY = min(height - 1, y + radius)
    var reds: [Double] = []
    var greens: [Double] = []
    var blues: [Double] = []
    var saturations: [Double] = []
    var luminances: [Double] = []
    for py in minY...maxY {
        for px in minX...maxX {
            // CGContext stores the first row at the lower edge. Convert the
            // screenshot's top-left UI coordinate to that buffer coordinate.
            let bufferY = height - 1 - py
            let offset = (bufferY * width + px) * 4
            let red = Double(pixels[offset]) / 255
            let green = Double(pixels[offset + 1]) / 255
            let blue = Double(pixels[offset + 2]) / 255
            let high = max(red, green, blue)
            let low = min(red, green, blue)
            reds.append(red)
            greens.append(green)
            blues.append(blue)
            saturations.append(high > 0 ? (high - low) / high : 0)
            luminances.append(red * 0.2126 + green * 0.7152 + blue * 0.0722)
        }
    }
    let meanLuminance = luminances.reduce(0, +) / Double(luminances.count)
    let deviation = sqrt(
        luminances.reduce(0) { $0 + pow($1 - meanLuminance, 2) } /
            Double(luminances.count)
    )
    return ProbeResult(
        x: x,
        y: y,
        meanRed: reds.reduce(0, +) / Double(reds.count),
        meanGreen: greens.reduce(0, +) / Double(greens.count),
        meanBlue: blues.reduce(0, +) / Double(blues.count),
        meanSaturation: saturations.reduce(0, +) / Double(saturations.count),
        luminanceDeviation: deviation
    )
}

do {
    guard CommandLine.arguments.count >= 3 else {
        throw NSError(domain: "Usage: mrzh-pixel-probe <image> <x,y;x,y> [radius]", code: 64)
    }
    let points = CommandLine.arguments[2].split(separator: ";").compactMap { source -> (Int, Int)? in
        let values = source.split(separator: ",").compactMap { Int($0) }
        guard values.count == 2 else { return nil }
        return (values[0], values[1])
    }
    let radius = CommandLine.arguments.count >= 4 ? Int(CommandLine.arguments[3]) ?? 20 : 20
    let image = try loadRGBA(path: CommandLine.arguments[1])
    let results = points.map {
        probe(
            pixels: image.pixels,
            width: image.width,
            height: image.height,
            x: $0.0,
            y: $0.1,
            radius: radius
        )
    }
    let data = try JSONEncoder().encode(results)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
