import CoreGraphics
import Foundation
import ImageIO

enum ImageMaskError: Error {
    case invalidArguments
    case cannotReadImage
    case cannotCreateContext
    case cannotWriteImage
}

func url(_ path: String) -> URL {
    URL(fileURLWithPath: path)
}

func main() throws {
    guard CommandLine.arguments.count == 7 else {
        throw ImageMaskError.invalidArguments
    }

    let inputPath = CommandLine.arguments[1]
    let outputPath = CommandLine.arguments[2]
    let left = CGFloat(Double(CommandLine.arguments[3]) ?? 0)
    let top = CGFloat(Double(CommandLine.arguments[4]) ?? 0)
    let right = CGFloat(Double(CommandLine.arguments[5]) ?? 0)
    let bottom = CGFloat(Double(CommandLine.arguments[6]) ?? 0)

    guard let source = CGImageSourceCreateWithURL(url(inputPath) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw ImageMaskError.cannotReadImage
    }

    let width = image.width
    let height = image.height
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: image.bitsPerComponent,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        throw ImageMaskError.cannotCreateContext
    }

    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    // Use an opaque neutral fill. OCR must not see the avatar artwork, while
    // the image dimensions and the rank/name/points coordinates stay unchanged.
    context.setFillColor(CGColor(
        red: 0.78,
        green: 0.74,
        blue: 0.66,
        alpha: 1
    ))
    let clampedLeft = max(0, min(CGFloat(width), left))
    let clampedRight = max(clampedLeft, min(CGFloat(width), right))
    let clampedTop = max(0, min(CGFloat(height), top))
    let clampedBottom = max(clampedTop, min(CGFloat(height), bottom))
    context.fill(CGRect(
        x: clampedLeft,
        y: CGFloat(height) - clampedBottom,
        width: clampedRight - clampedLeft,
        height: clampedBottom - clampedTop
    ))

    guard let output = CGImageDestinationCreateWithURL(
        url(outputPath) as CFURL,
        "public.png" as CFString,
        1,
        nil
    ), let maskedImage = context.makeImage() else {
        throw ImageMaskError.cannotWriteImage
    }
    CGImageDestinationAddImage(output, maskedImage, nil)
    if !CGImageDestinationFinalize(output) {
        throw ImageMaskError.cannotWriteImage
    }
}

do {
    try main()
} catch {
    fputs("mrzh-image-mask: \(error)\n", stderr)
    exit(1)
}
