import qrcode from 'qrcode-generator';

// The QR code of an `otpauth://` link as plain SVG: one <path> of unit squares. Only presentation attributes (no style
// attribute, no <style>), so the strict CSP is unchanged. Black on white in BOTH themes on purpose: scanners expect it.

/** the white margin a scanner needs, in modules */
const QUIET = 4;

export function qrPath(text: string): { d: string; size: number } {
  // type 0 = the smallest version that fits; M = 15 % error correction. The link is ASCII (percent-encoded).
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  let d = '';
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
    }
  }
  return { d, size: modules + QUIET * 2 };
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const { d, size } = qrPath(text);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      width="232"
      height="232"
      shapeRendering="crispEdges"
      className="mx-auto block h-auto max-w-full"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
