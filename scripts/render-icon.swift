import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let yellow = NSImage(contentsOf: root.appendingPathComponent("public/zong-yellow.png"))!
let blue = NSImage(contentsOf: root.appendingPathComponent("public/zong-blue.png"))!

func render(_ size: CGFloat, _ name: String) {
  let image = NSImage(size: NSSize(width: size, height: size))
  image.lockFocus()
  NSColor.black.setFill()
  NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size), xRadius: size * 0.22, yRadius: size * 0.22).fill()
  let scale = size / 512
  let width = 538 * scale, height = 293 * scale, x = -13 * scale
  // Icon Composer positions Yellow above Blue; AppKit’s origin is at the bottom.
  yellow.draw(in: NSRect(x: x, y: 232 * scale, width: width, height: height), from: .zero, operation: .sourceOver, fraction: 1)
  blue.draw(in: NSRect(x: x, y: -13 * scale, width: width, height: height), from: .zero, operation: .sourceOver, fraction: 1)
  image.unlockFocus()
  let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
  try! rep.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent("public/" + name))
}
render(512, "icon-512.png")
render(192, "icon-192.png")
