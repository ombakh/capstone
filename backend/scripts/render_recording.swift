import AppKit
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum RenderError: LocalizedError {
  case missingArgument(String)
  case invalidArgument(String)
  case unableToCreateWriter(String)
  case unableToCreateContext
  case unableToCreateImage
  case unableToEncodeJpeg
  case unableToCreateSampleBuffer
  case appendFailed(String)

  var errorDescription: String? {
    switch self {
    case .missingArgument(let name):
      return "Missing required argument \(name)"
    case .invalidArgument(let detail):
      return detail
    case .unableToCreateWriter(let detail):
      return detail
    case .unableToCreateContext:
      return "Unable to create a Core Graphics rendering context"
    case .unableToCreateImage:
      return "Unable to create a rendered video frame image"
    case .unableToEncodeJpeg:
      return "Unable to encode a rendered frame as JPEG"
    case .unableToCreateSampleBuffer:
      return "Unable to create a video sample buffer"
    case .appendFailed(let detail):
      return detail
    }
  }
}

struct CLIOptions {
  let sessionDir: URL
  let outputURL: URL
  let width: Int
  let height: Int
  let fps: Int
}

struct ManifestFile: Decodable {
  let recording: RecordingManifest?
}

struct RecordingManifest: Decodable {
  let startedAt: String?
  let endedAt: String?
  let durationMs: Double?
}

struct CameraMetadata: Decodable {
  let cameraName: String
  let capturedAt: String?
  let receivedAt: String?
  let timelineMs: Double?
  let sequence: Int?
  let width: Int?
  let height: Int?
  let mimeType: String?
  let file: String
}

struct LidarEvent: Decodable {
  let timestamp: String?
  let receivedAt: String?
  let timelineMs: Double?
  let payload: LidarPayload
}

struct LidarPayload: Decodable {
  let points: [[Double]]?
  let maxDistanceMm: Double?
  let pointCount: Int?
}

struct CameraFrame {
  let cameraName: String
  let timelineMs: Double
  let imageURL: URL
}

struct LidarPoint {
  let angleDeg: CGFloat
  let distanceMm: CGFloat
}

struct LidarScan {
  let timelineMs: Double
  let points: [LidarPoint]
  let maxDistanceMm: CGFloat
}

struct ProjectedLidarPoint {
  let angleDeg: CGFloat
  let distanceMm: CGFloat
  let distanceRatio: CGFloat
  let x: CGFloat
  let y: CGFloat
}

struct Layout {
  let canvasRect: CGRect
  let lidarCardRect: CGRect
  let lidarMapRect: CGRect
  let frontCameraRect: CGRect
  let backCameraRect: CGRect
  let footerRect: CGRect
}

final class ImageCache {
  private var cache: [String: CGImage] = [:]

  func image(for url: URL) -> CGImage? {
    if let cached = cache[url.path] {
      return cached
    }

    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
      return nil
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
      return nil
    }

    cache[url.path] = image
    return image
  }
}

let lidarPulseCycleMs: Double = 4200
let lidarPulseRingCount = 3
let lidarSegmentMaxAngleGapDeg: CGFloat = 8
let lidarSegmentMaxPixelGapRatio: CGFloat = 0.18
let lidarSegmentDistanceGapRatio: CGFloat = 0.16
let lidarSegmentMinDistanceGapMm: CGFloat = 260

let isoFormatterWithFractionalSeconds: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

let isoFormatterFallback: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter
}()

func parseArguments() throws -> CLIOptions {
  let arguments = Array(CommandLine.arguments.dropFirst())
  var values: [String: String] = [:]

  var index = 0
  while index < arguments.count {
    let argument = arguments[index]
    if argument.hasPrefix("--") {
      let key = argument
      let valueIndex = index + 1
      guard valueIndex < arguments.count else {
        throw RenderError.missingArgument(key)
      }
      values[key] = arguments[valueIndex]
      index += 2
      continue
    }
    index += 1
  }

  guard let sessionDirValue = values["--session-dir"], !sessionDirValue.isEmpty else {
    throw RenderError.missingArgument("--session-dir")
  }
  guard let outputValue = values["--output"], !outputValue.isEmpty else {
    throw RenderError.missingArgument("--output")
  }

  let width = Int(values["--width"] ?? "1280") ?? 1280
  let height = Int(values["--height"] ?? "720") ?? 720
  let fps = Int(values["--fps"] ?? "12") ?? 12

  if width < 320 || height < 180 {
    throw RenderError.invalidArgument("Recording video size must be at least 320x180")
  }
  if fps < 1 {
    throw RenderError.invalidArgument("Recording video FPS must be at least 1")
  }

  return CLIOptions(
    sessionDir: URL(fileURLWithPath: sessionDirValue),
    outputURL: URL(fileURLWithPath: outputValue),
    width: width,
    height: height,
    fps: fps
  )
}

func parseDate(_ value: String?) -> Date? {
  guard let value, !value.isEmpty else {
    return nil
  }

  return isoFormatterWithFractionalSeconds.date(from: value) ?? isoFormatterFallback.date(from: value)
}

func loadManifest(from sessionDir: URL) -> ManifestFile? {
  let manifestURL = sessionDir.appendingPathComponent("manifest.json")
  guard let data = try? Data(contentsOf: manifestURL) else {
    return nil
  }
  return try? JSONDecoder().decode(ManifestFile.self, from: data)
}

func loadNDJSONLines(from fileURL: URL) -> [String] {
  guard let content = try? String(contentsOf: fileURL, encoding: .utf8) else {
    return []
  }

  return content
    .split(whereSeparator: \.isNewline)
    .map(String.init)
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
}

func resolveTimelineMs(explicitTimelineMs: Double?, primaryTimestamp: String?, fallbackTimestamp: String?, recordingStartDate: Date?) -> Double? {
  if let explicitTimelineMs, explicitTimelineMs >= 0 {
    return explicitTimelineMs
  }

  guard let recordingStartDate else {
    return nil
  }

  if let primaryDate = parseDate(primaryTimestamp) {
    return max(0, primaryDate.timeIntervalSince(recordingStartDate) * 1000)
  }
  if let fallbackDate = parseDate(fallbackTimestamp) {
    return max(0, fallbackDate.timeIntervalSince(recordingStartDate) * 1000)
  }

  return nil
}

func loadCameraFrames(named cameraName: String, sessionDir: URL, recordingStartDate: Date?) -> [CameraFrame] {
  let metadataURL = sessionDir.appendingPathComponent("camera-\(cameraName).ndjson")
  let decoder = JSONDecoder()

  return loadNDJSONLines(from: metadataURL).compactMap { line in
    guard let data = line.data(using: .utf8),
          let metadata = try? decoder.decode(CameraMetadata.self, from: data)
    else {
      return nil
    }

    let timelineMs = resolveTimelineMs(
      explicitTimelineMs: metadata.timelineMs,
      primaryTimestamp: metadata.receivedAt,
      fallbackTimestamp: metadata.capturedAt,
      recordingStartDate: recordingStartDate
    ) ?? 0

    return CameraFrame(
      cameraName: metadata.cameraName,
      timelineMs: timelineMs,
      imageURL: sessionDir.appendingPathComponent(metadata.file)
    )
  }
  .sorted { left, right in
    if left.timelineMs == right.timelineMs {
      return left.imageURL.lastPathComponent < right.imageURL.lastPathComponent
    }
    return left.timelineMs < right.timelineMs
  }
}

func loadLidarScans(sessionDir: URL, recordingStartDate: Date?) -> [LidarScan] {
  let lidarURL = sessionDir.appendingPathComponent("lidar.ndjson")
  let decoder = JSONDecoder()

  return loadNDJSONLines(from: lidarURL).compactMap { line in
    guard let data = line.data(using: .utf8),
          let event = try? decoder.decode(LidarEvent.self, from: data)
    else {
      return nil
    }

    let points = (event.payload.points ?? []).compactMap { point -> LidarPoint? in
      guard point.count >= 2 else {
        return nil
      }
      let angle = CGFloat(point[0])
      let distance = CGFloat(point[1])
      if !angle.isFinite || !distance.isFinite || distance <= 0 {
        return nil
      }
      return LidarPoint(angleDeg: angle, distanceMm: distance)
    }

    let timelineMs = resolveTimelineMs(
      explicitTimelineMs: event.timelineMs,
      primaryTimestamp: event.receivedAt,
      fallbackTimestamp: event.timestamp,
      recordingStartDate: recordingStartDate
    ) ?? 0

    return LidarScan(
      timelineMs: timelineMs,
      points: points,
      maxDistanceMm: CGFloat(max(event.payload.maxDistanceMm ?? 6000, 1))
    )
  }
  .sorted { $0.timelineMs < $1.timelineMs }
}

func clamp<T: Comparable>(_ value: T, min minValue: T, max maxValue: T) -> T {
  return min(maxValue, max(minValue, value))
}

func topRect(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, canvasHeight: CGFloat) -> CGRect {
  return CGRect(x: x, y: canvasHeight - y - height, width: width, height: height)
}

func makeLayout(width: Int, height: Int) -> Layout {
  let canvasWidth = CGFloat(width)
  let canvasHeight = CGFloat(height)
  let padding = max(28, canvasWidth * 0.03)
  let gutter = max(22, canvasWidth * 0.02)
  let rightColumnWidth = clamp(canvasWidth * 0.28, min: 280, max: 380)
  let leftColumnWidth = max(420, canvasWidth - (padding * 2) - gutter - rightColumnWidth)
  let contentHeight = canvasHeight - (padding * 2)
  let cameraHeight = (contentHeight - gutter) / 2

  let lidarCardRect = topRect(
    x: padding,
    y: padding,
    width: leftColumnWidth,
    height: contentHeight,
    canvasHeight: canvasHeight
  )

  let lidarMapDiameter = min(leftColumnWidth - 88, contentHeight - 160)
  let lidarMapX = padding + ((leftColumnWidth - lidarMapDiameter) / 2)
  let lidarMapY = padding + 92
  let lidarMapRect = topRect(
    x: lidarMapX,
    y: lidarMapY,
    width: lidarMapDiameter,
    height: lidarMapDiameter,
    canvasHeight: canvasHeight
  )

  let cameraColumnX = padding + leftColumnWidth + gutter
  let frontCameraRect = topRect(
    x: cameraColumnX,
    y: padding,
    width: rightColumnWidth,
    height: cameraHeight,
    canvasHeight: canvasHeight
  )
  let backCameraRect = topRect(
    x: cameraColumnX,
    y: padding + cameraHeight + gutter,
    width: rightColumnWidth,
    height: cameraHeight,
    canvasHeight: canvasHeight
  )

  let footerRect = topRect(
    x: padding + 34,
    y: padding + contentHeight - 84,
    width: leftColumnWidth - 68,
    height: 44,
    canvasHeight: canvasHeight
  )

  return Layout(
    canvasRect: CGRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight),
    lidarCardRect: lidarCardRect,
    lidarMapRect: lidarMapRect,
    frontCameraRect: frontCameraRect,
    backCameraRect: backCameraRect,
    footerRect: footerRect
  )
}

func withGraphicsContext(_ context: CGContext, draw block: () -> Void) {
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
  block()
  NSGraphicsContext.restoreGraphicsState()
}

func drawText(_ text: String, in rect: CGRect, font: NSFont, color: NSColor, alignment: NSTextAlignment = .left, uppercase: Bool = false) {
  let paragraph = NSMutableParagraphStyle()
  paragraph.alignment = alignment

  let attributes: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: color,
    .paragraphStyle: paragraph
  ]

  let content = uppercase ? text.uppercased() : text
  NSString(string: content).draw(
    with: rect,
    options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
    attributes: attributes
  )
}

func fillRoundedRect(_ context: CGContext, rect: CGRect, radius: CGFloat, fillColor: NSColor, strokeColor: NSColor? = nil, lineWidth: CGFloat = 1) {
  let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
  context.saveGState()
  context.addPath(path)
  context.setFillColor(fillColor.cgColor)
  context.fillPath()
  context.restoreGState()

  if let strokeColor {
    context.saveGState()
    context.addPath(path)
    context.setStrokeColor(strokeColor.cgColor)
    context.setLineWidth(lineWidth)
    context.strokePath()
    context.restoreGState()
  }
}

func fillGradient(_ context: CGContext, rect: CGRect, startColor: NSColor, endColor: NSColor, angleDegrees: CGFloat = -90) {
  guard let gradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [startColor.cgColor, endColor.cgColor] as CFArray,
    locations: [0, 1]
  ) else {
    return
  }

  let radians = angleDegrees * (.pi / 180)
  let vector = CGPoint(x: cos(radians), y: sin(radians))
  let center = CGPoint(x: rect.midX, y: rect.midY)
  let span = max(rect.width, rect.height) / 2
  let startPoint = CGPoint(x: center.x - vector.x * span, y: center.y - vector.y * span)
  let endPoint = CGPoint(x: center.x + vector.x * span, y: center.y + vector.y * span)

  context.saveGState()
  context.addRect(rect)
  context.clip()
  context.drawLinearGradient(gradient, start: startPoint, end: endPoint, options: [])
  context.restoreGState()
}

func drawImageCover(_ context: CGContext, image: CGImage, rect: CGRect, cornerRadius: CGFloat) {
  let imageAspect = CGFloat(image.width) / CGFloat(image.height)
  let rectAspect = rect.width / rect.height
  var drawRect = rect

  if imageAspect > rectAspect {
    let width = rect.height * imageAspect
    drawRect = CGRect(x: rect.midX - (width / 2), y: rect.minY, width: width, height: rect.height)
  } else {
    let height = rect.width / imageAspect
    drawRect = CGRect(x: rect.minX, y: rect.midY - (height / 2), width: rect.width, height: height)
  }

  context.saveGState()
  let path = CGPath(roundedRect: rect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
  context.addPath(path)
  context.clip()
  context.draw(image, in: drawRect)
  context.restoreGState()
}

func formatDuration(_ milliseconds: Double) -> String {
  let totalSeconds = max(0, Int(milliseconds.rounded() / 1000))
  let minutes = totalSeconds / 60
  let seconds = totalSeconds % 60
  return String(format: "%02d:%02d", minutes, seconds)
}

func projectLidarPoints(_ points: [LidarPoint], maxDistanceMm: CGFloat, center: CGPoint, radius: CGFloat) -> [ProjectedLidarPoint] {
  return points
    .sorted { $0.angleDeg < $1.angleDeg }
    .filter { $0.distanceMm <= maxDistanceMm }
    .map { point in
      let angleRadians = ((point.angleDeg - 90) * .pi) / 180
      let distanceRatio = min(1, point.distanceMm / maxDistanceMm)
      let pointRadius = distanceRatio * radius
      let x = center.x + cos(angleRadians) * pointRadius
      let y = center.y + sin(angleRadians) * pointRadius

      return ProjectedLidarPoint(
        angleDeg: point.angleDeg,
        distanceMm: point.distanceMm,
        distanceRatio: distanceRatio,
        x: x,
        y: y
      )
    }
}

func buildLidarSegments(_ projectedPoints: [ProjectedLidarPoint], radius: CGFloat) -> [[ProjectedLidarPoint]] {
  guard projectedPoints.count > 1 else {
    return []
  }

  var segments: [[ProjectedLidarPoint]] = []
  var currentSegment = [projectedPoints[0]]

  for index in 1..<projectedPoints.count {
    let previous = projectedPoints[index - 1]
    let current = projectedPoints[index]
    let angleGap = current.angleDeg - previous.angleDeg
    let distanceGap = abs(current.distanceMm - previous.distanceMm)
    let allowedDistanceGap = max(
      lidarSegmentMinDistanceGapMm,
      max(previous.distanceMm, current.distanceMm) * lidarSegmentDistanceGapRatio
    )
    let pixelGap = hypot(current.x - previous.x, current.y - previous.y)

    if angleGap <= lidarSegmentMaxAngleGapDeg &&
      distanceGap <= allowedDistanceGap &&
      pixelGap <= radius * lidarSegmentMaxPixelGapRatio
    {
      currentSegment.append(current)
      continue
    }

    if currentSegment.count > 1 {
      segments.append(currentSegment)
    }
    currentSegment = [current]
  }

  if currentSegment.count > 1 {
    segments.append(currentSegment)
  }

  return segments
}

func drawLidarMap(context: CGContext, rect: CGRect, scan: LidarScan?, timestampMs: Double) {
  let center = CGPoint(x: rect.midX, y: rect.midY)
  let radius = min(rect.width, rect.height) * 0.48

  context.saveGState()
  context.addEllipse(in: rect)
  context.clip()

  let backgroundGradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [
      NSColor(srgbRed: 0.07, green: 0.21, blue: 0.35, alpha: 0.96).cgColor,
      NSColor(srgbRed: 0.02, green: 0.08, blue: 0.14, alpha: 1).cgColor
    ] as CFArray,
    locations: [0, 1]
  )

  if let backgroundGradient {
    context.drawRadialGradient(
      backgroundGradient,
      startCenter: center,
      startRadius: 0,
      endCenter: center,
      endRadius: radius,
      options: []
    )
  }

  context.setStrokeColor(NSColor(srgbRed: 0.58, green: 0.77, blue: 0.95, alpha: 0.28).cgColor)
  context.setLineWidth(1)
  for step in 1...3 {
    let ringRadius = radius * CGFloat(step) / 3
    context.strokeEllipse(in: CGRect(x: center.x - ringRadius, y: center.y - ringRadius, width: ringRadius * 2, height: ringRadius * 2))
  }
  context.move(to: CGPoint(x: center.x - radius, y: center.y))
  context.addLine(to: CGPoint(x: center.x + radius, y: center.y))
  context.move(to: CGPoint(x: center.x, y: center.y - radius))
  context.addLine(to: CGPoint(x: center.x, y: center.y + radius))
  context.strokePath()

  let pulseProgress = (timestampMs.truncatingRemainder(dividingBy: lidarPulseCycleMs)) / lidarPulseCycleMs
  let corePulse = 0.5 + 0.5 * sin((timestampMs / lidarPulseCycleMs) * .pi * 2)
  for ringIndex in 0..<lidarPulseRingCount {
    let phase = (pulseProgress + (Double(ringIndex) / Double(lidarPulseRingCount))).truncatingRemainder(dividingBy: 1)
    let ringRadius = max(radius * 0.12, radius * CGFloat(phase))
    let alpha = pow(1 - phase, 1.55) * 0.15
    context.setStrokeColor(NSColor(srgbRed: 0.45, green: 0.66, blue: 0.83, alpha: alpha).cgColor)
    context.setLineWidth(1 + CGFloat(pow(1 - phase, 1.1)) * 1.6)
    context.strokeEllipse(in: CGRect(x: center.x - ringRadius, y: center.y - ringRadius, width: ringRadius * 2, height: ringRadius * 2))
  }

  if let scan, !scan.points.isEmpty {
    let projectedPoints = projectLidarPoints(scan.points, maxDistanceMm: max(scan.maxDistanceMm, 1), center: center, radius: radius)
    let segments = buildLidarSegments(projectedPoints, radius: radius)

    context.saveGState()
    context.setLineCap(.round)
    context.setLineJoin(.round)
    for segment in segments {
      let averageNearFactor = segment.reduce(CGFloat.zero) { partial, point in
        partial + (1 - point.distanceRatio)
      } / CGFloat(max(1, segment.count))
      let alpha = min(0.72, 0.22 + averageNearFactor * 0.34)
      let width = 1.2 + averageNearFactor * 1.8
      context.setStrokeColor(NSColor(srgbRed: 0.47, green: 0.88, blue: 1, alpha: alpha).cgColor)
      context.setLineWidth(width)
      context.beginPath()
      context.move(to: CGPoint(x: segment[0].x, y: segment[0].y))
      for point in segment.dropFirst() {
        context.addLine(to: CGPoint(x: point.x, y: point.y))
      }
      context.strokePath()
    }

    for point in projectedPoints {
      let nearFactor = 1 - point.distanceRatio
      let alpha = min(0.96, 0.34 + nearFactor * 0.62)
      let pointSize = 2.2 + nearFactor * 3.2
      context.setFillColor(NSColor(srgbRed: 0.57, green: 1, blue: 0.82, alpha: alpha).cgColor)
      context.fillEllipse(in: CGRect(x: point.x - pointSize / 2, y: point.y - pointSize / 2, width: pointSize, height: pointSize))
    }
    context.restoreGState()
  }

  let glowAlpha = 0.08 + CGFloat(corePulse) * 0.06
  context.setFillColor(NSColor(srgbRed: 0.62, green: 0.76, blue: 0.9, alpha: glowAlpha).cgColor)
  context.fillEllipse(in: CGRect(x: center.x - 18, y: center.y - 18, width: 36, height: 36))
  context.setFillColor(NSColor(srgbRed: 1, green: 0.32, blue: 0.32, alpha: 0.98).cgColor)
  context.fillEllipse(in: CGRect(x: center.x - 4.5, y: center.y - 4.5, width: 9, height: 9))

  context.restoreGState()
  context.setStrokeColor(NSColor(srgbRed: 0.66, green: 0.85, blue: 1, alpha: 0.54).cgColor)
  context.setLineWidth(1.2)
  context.strokeEllipse(in: rect.insetBy(dx: 1.5, dy: 1.5))
}

func drawCameraPanel(context: CGContext, rect: CGRect, label: String, image: CGImage?) {
  fillRoundedRect(
    context,
    rect: rect,
    radius: 22,
    fillColor: NSColor(srgbRed: 0.04, green: 0.08, blue: 0.14, alpha: 0.94),
    strokeColor: NSColor(srgbRed: 0.52, green: 0.73, blue: 0.92, alpha: 0.32),
    lineWidth: 1
  )

  let innerRect = rect.insetBy(dx: 12, dy: 12)
  if let image {
    drawImageCover(context, image: image, rect: innerRect, cornerRadius: 18)
  } else {
    fillGradient(
      context,
      rect: innerRect,
      startColor: NSColor(srgbRed: 0.16, green: 0.28, blue: 0.38, alpha: 1),
      endColor: NSColor(srgbRed: 0.06, green: 0.11, blue: 0.16, alpha: 1),
      angleDegrees: -135
    )
    fillRoundedRect(
      context,
      rect: innerRect,
      radius: 18,
      fillColor: NSColor.clear,
      strokeColor: NSColor(srgbRed: 0.62, green: 0.82, blue: 0.98, alpha: 0.2),
      lineWidth: 1
    )
    withGraphicsContext(context) {
      drawText(
        "Waiting for \(label.lowercased()) feed",
        in: innerRect.insetBy(dx: 18, dy: 18),
        font: NSFont.systemFont(ofSize: 18, weight: .medium),
        color: NSColor(srgbRed: 0.9, green: 0.96, blue: 1, alpha: 0.82),
        alignment: .center
      )
    }
  }

  let labelRect = CGRect(x: rect.minX + 18, y: rect.maxY - 34, width: rect.width - 36, height: 20)
  withGraphicsContext(context) {
    drawText(
      label,
      in: labelRect,
      font: NSFont.systemFont(ofSize: 12, weight: .semibold),
      color: NSColor(srgbRed: 0.93, green: 0.97, blue: 1, alpha: 0.94),
      uppercase: true
    )
  }
}

func createVideoFormatDescription(width: Int32, height: Int32) throws -> CMFormatDescription {
  var formatDescription: CMFormatDescription?
  let status = CMVideoFormatDescriptionCreate(
    allocator: kCFAllocatorDefault,
    codecType: kCMVideoCodecType_JPEG,
    width: width,
    height: height,
    extensions: nil,
    formatDescriptionOut: &formatDescription
  )

  guard status == noErr, let formatDescription else {
    throw RenderError.unableToCreateSampleBuffer
  }
  return formatDescription
}

func createSampleBuffer(jpegData: Data, formatDescription: CMFormatDescription, presentationTime: CMTime, duration: CMTime) throws -> CMSampleBuffer {
  var blockBuffer: CMBlockBuffer?
  let blockStatus = CMBlockBufferCreateWithMemoryBlock(
    allocator: kCFAllocatorDefault,
    memoryBlock: nil,
    blockLength: jpegData.count,
    blockAllocator: kCFAllocatorDefault,
    customBlockSource: nil,
    offsetToData: 0,
    dataLength: jpegData.count,
    flags: 0,
    blockBufferOut: &blockBuffer
  )

  guard blockStatus == kCMBlockBufferNoErr, let blockBuffer else {
    throw RenderError.unableToCreateSampleBuffer
  }

  let replaceStatus = jpegData.withUnsafeBytes { rawBuffer in
    guard let baseAddress = rawBuffer.baseAddress else {
      return kCMBlockBufferBadPointerParameterErr
    }

    return CMBlockBufferReplaceDataBytes(
      with: baseAddress,
      blockBuffer: blockBuffer,
      offsetIntoDestination: 0,
      dataLength: jpegData.count
    )
  }
  guard replaceStatus == noErr else {
    throw RenderError.unableToCreateSampleBuffer
  }

  var timing = CMSampleTimingInfo(duration: duration, presentationTimeStamp: presentationTime, decodeTimeStamp: .invalid)
  var sampleSize = jpegData.count
  var sampleBuffer: CMSampleBuffer?
  let sampleStatus = CMSampleBufferCreateReady(
    allocator: kCFAllocatorDefault,
    dataBuffer: blockBuffer,
    formatDescription: formatDescription,
    sampleCount: 1,
    sampleTimingEntryCount: 1,
    sampleTimingArray: &timing,
    sampleSizeEntryCount: 1,
    sampleSizeArray: &sampleSize,
    sampleBufferOut: &sampleBuffer
  )

  guard sampleStatus == noErr, let sampleBuffer else {
    throw RenderError.unableToCreateSampleBuffer
  }
  return sampleBuffer
}

func renderFrameJpegData(
  options: CLIOptions,
  layout: Layout,
  elapsedMs: Double,
  totalDurationMs: Double,
  lidarScan: LidarScan?,
  frontImage: CGImage?,
  backImage: CGImage?
) throws -> Data {
  let bytesPerRow = options.width * 4
  let buffer = UnsafeMutableRawPointer.allocate(byteCount: options.height * bytesPerRow, alignment: 16)
  defer {
    buffer.deallocate()
  }

  guard let context = CGContext(
    data: buffer,
    width: options.width,
    height: options.height,
    bitsPerComponent: 8,
    bytesPerRow: bytesPerRow,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
  ) else {
    throw RenderError.unableToCreateContext
  }

  fillGradient(
    context,
    rect: layout.canvasRect,
    startColor: NSColor(srgbRed: 0.03, green: 0.08, blue: 0.12, alpha: 1),
    endColor: NSColor(srgbRed: 0.01, green: 0.03, blue: 0.06, alpha: 1),
    angleDegrees: -100
  )

  fillRoundedRect(
    context,
    rect: layout.lidarCardRect,
    radius: 28,
    fillColor: NSColor(srgbRed: 0.04, green: 0.09, blue: 0.15, alpha: 0.9),
    strokeColor: NSColor(srgbRed: 0.4, green: 0.65, blue: 0.88, alpha: 0.24),
    lineWidth: 1.2
  )

  drawCameraPanel(context: context, rect: layout.frontCameraRect, label: "Front Camera", image: frontImage)
  drawCameraPanel(context: context, rect: layout.backCameraRect, label: "Rear Camera", image: backImage)
  drawLidarMap(context: context, rect: layout.lidarMapRect, scan: lidarScan, timestampMs: elapsedMs)

  withGraphicsContext(context) {
    drawText(
      "LiDAR Session Playback",
      in: CGRect(x: layout.lidarCardRect.minX + 34, y: layout.lidarCardRect.maxY - 48, width: layout.lidarCardRect.width - 68, height: 24),
      font: NSFont.systemFont(ofSize: 20, weight: .bold),
      color: NSColor(srgbRed: 0.95, green: 0.98, blue: 1, alpha: 0.98)
    )

    let subtitle = "Fixed layout: LiDAR primary, front and rear cameras alongside"
    drawText(
      subtitle,
      in: CGRect(x: layout.lidarCardRect.minX + 34, y: layout.lidarCardRect.maxY - 76, width: layout.lidarCardRect.width - 68, height: 18),
      font: NSFont.systemFont(ofSize: 12, weight: .medium),
      color: NSColor(srgbRed: 0.73, green: 0.86, blue: 0.96, alpha: 0.82)
    )

    let rangeText = "Range \(String(format: "%.1f", Double((lidarScan?.maxDistanceMm ?? 6000) / 1000))) m"
    drawText(
      rangeText,
      in: CGRect(x: layout.lidarMapRect.minX, y: layout.lidarMapRect.minY - 28, width: layout.lidarMapRect.width, height: 18),
      font: NSFont.systemFont(ofSize: 12, weight: .semibold),
      color: NSColor(srgbRed: 0.78, green: 0.97, blue: 0.86, alpha: 0.88),
      alignment: .center,
      uppercase: true
    )

    let elapsedLabel = "Elapsed \(formatDuration(elapsedMs))"
    drawText(
      elapsedLabel,
      in: CGRect(x: layout.footerRect.minX, y: layout.footerRect.minY + 16, width: layout.footerRect.width / 2, height: 18),
      font: NSFont.systemFont(ofSize: 12, weight: .semibold),
      color: NSColor(srgbRed: 0.94, green: 0.98, blue: 1, alpha: 0.9),
      uppercase: true
    )

    let durationLabel = "Duration \(formatDuration(totalDurationMs))"
    drawText(
      durationLabel,
      in: CGRect(x: layout.footerRect.minX + (layout.footerRect.width / 2), y: layout.footerRect.minY + 16, width: layout.footerRect.width / 2, height: 18),
      font: NSFont.systemFont(ofSize: 12, weight: .semibold),
      color: NSColor(srgbRed: 0.76, green: 0.9, blue: 1, alpha: 0.82),
      alignment: .right,
      uppercase: true
    )
  }

  guard let image = context.makeImage() else {
    throw RenderError.unableToCreateImage
  }

  let jpegData = NSMutableData()
  guard let destination = CGImageDestinationCreateWithData(
    jpegData,
    UTType.jpeg.identifier as CFString,
    1,
    nil
  ) else {
    throw RenderError.unableToEncodeJpeg
  }

  let properties: [CFString: Any] = [
    kCGImageDestinationLossyCompressionQuality: 0.88
  ]
  CGImageDestinationAddImage(destination, image, properties as CFDictionary)
  guard CGImageDestinationFinalize(destination) else {
    throw RenderError.unableToEncodeJpeg
  }

  return jpegData as Data
}

func frameCount(durationMs: Double, fps: Int) -> Int {
  let effectiveDurationMs = max(durationMs, 1000)
  return max(1, Int(ceil((effectiveDurationMs / 1000) * Double(fps))))
}

func advanceCurrentFrame<T>(for timeMs: Double, frames: [T], index: inout Int, current: inout T?, timeline: (T) -> Double) {
  while index < frames.count && timeline(frames[index]) <= timeMs {
    current = frames[index]
    index += 1
  }
}

func writeVideo(options: CLIOptions, layout: Layout, durationMs: Double, frontFrames: [CameraFrame], backFrames: [CameraFrame], lidarScans: [LidarScan]) throws {
  let fileManager = FileManager.default
  let outputDirectory = options.outputURL.deletingLastPathComponent()
  try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true, attributes: nil)
  if fileManager.fileExists(atPath: options.outputURL.path) {
    try fileManager.removeItem(at: options.outputURL)
  }

  let formatDescription = try createVideoFormatDescription(width: Int32(options.width), height: Int32(options.height))
  let writer = try AVAssetWriter(url: options.outputURL, fileType: .mp4)
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: formatDescription)
  input.expectsMediaDataInRealTime = false

  guard writer.canAdd(input) else {
    throw RenderError.unableToCreateWriter("Unable to attach the MJPEG input to the recording writer")
  }
  writer.add(input)

  guard writer.startWriting() else {
    let reason = writer.error?.localizedDescription ?? "unknown writer error"
    throw RenderError.unableToCreateWriter("Unable to start MP4 writing: \(reason)")
  }
  writer.startSession(atSourceTime: .zero)

  let imageCache = ImageCache()
  let totalFrames = frameCount(durationMs: durationMs, fps: options.fps)
  var frontIndex = 0
  var backIndex = 0
  var lidarIndex = 0
  var currentFrontFrame: CameraFrame?
  var currentBackFrame: CameraFrame?
  var currentLidarScan: LidarScan?

  for frameNumber in 0..<totalFrames {
    var renderError: Error?
    autoreleasepool {
      let timeMs = (Double(frameNumber) * 1000) / Double(options.fps)

      advanceCurrentFrame(for: timeMs, frames: frontFrames, index: &frontIndex, current: &currentFrontFrame) { $0.timelineMs }
      advanceCurrentFrame(for: timeMs, frames: backFrames, index: &backIndex, current: &currentBackFrame) { $0.timelineMs }
      advanceCurrentFrame(for: timeMs, frames: lidarScans, index: &lidarIndex, current: &currentLidarScan) { $0.timelineMs }

      let frontImage = currentFrontFrame.flatMap { imageCache.image(for: $0.imageURL) }
      let backImage = currentBackFrame.flatMap { imageCache.image(for: $0.imageURL) }

      do {
        while !input.isReadyForMoreMediaData {
          Thread.sleep(forTimeInterval: 0.003)
        }

        let jpegData = try renderFrameJpegData(
          options: options,
          layout: layout,
          elapsedMs: timeMs,
          totalDurationMs: durationMs,
          lidarScan: currentLidarScan,
          frontImage: frontImage,
          backImage: backImage
        )

        let frameDuration = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        let presentationTime = CMTime(value: CMTimeValue(frameNumber), timescale: CMTimeScale(options.fps))
        let sampleBuffer = try createSampleBuffer(
          jpegData: jpegData,
          formatDescription: formatDescription,
          presentationTime: presentationTime,
          duration: frameDuration
        )

        if !input.append(sampleBuffer) {
          let reason = writer.error?.localizedDescription ?? "unknown append error"
          throw RenderError.appendFailed("Unable to append video frame \(frameNumber): \(reason)")
        }
      } catch {
        renderError = error
      }
    }

    if let renderError {
      throw renderError
    }
  }

  input.markAsFinished()
  let semaphore = DispatchSemaphore(value: 0)
  writer.finishWriting {
    semaphore.signal()
  }
  semaphore.wait()

  if writer.status != .completed {
    let reason = writer.error?.localizedDescription ?? "unknown completion error"
    throw RenderError.unableToCreateWriter("Unable to finalize MP4 recording: \(reason)")
  }
}

func main() throws {
  let options = try parseArguments()
  let manifest = loadManifest(from: options.sessionDir)
  let recordingStartDate = parseDate(manifest?.recording?.startedAt)
  let frontFrames = loadCameraFrames(named: "front", sessionDir: options.sessionDir, recordingStartDate: recordingStartDate)
  let backFrames = loadCameraFrames(named: "back", sessionDir: options.sessionDir, recordingStartDate: recordingStartDate)
  let lidarScans = loadLidarScans(sessionDir: options.sessionDir, recordingStartDate: recordingStartDate)

  let detectedDurationMs = [
    manifest?.recording?.durationMs ?? 0,
    frontFrames.last?.timelineMs ?? 0,
    backFrames.last?.timelineMs ?? 0,
    lidarScans.last?.timelineMs ?? 0
  ].max() ?? 0

  let layout = makeLayout(width: options.width, height: options.height)
  try writeVideo(
    options: options,
    layout: layout,
    durationMs: detectedDurationMs,
    frontFrames: frontFrames,
    backFrames: backFrames,
    lidarScans: lidarScans
  )
}

do {
  try main()
} catch {
  let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
  if let data = "\(message)\n".data(using: .utf8) {
    FileHandle.standardError.write(data)
  }
  exit(1)
}
