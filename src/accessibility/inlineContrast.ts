const opaqueHex = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

/** WCAG relative luminance for opaque sRGB hex colours. */
export function relativeLuminance(colour: string): number | undefined {
  if (!opaqueHex.test(colour)) return undefined;
  const hex = colour.length === 4 ? colour.slice(1).replace(/./g, digit => digit + digit) : colour.slice(1);
  const linearChannel = (offset: number) => {
    const srgb = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearChannel(0) + 0.7152 * linearChannel(2) + 0.0722 * linearChannel(4);
}

export function contrastRatio(foreground: string, background: string): number | undefined {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  if (first === undefined || second === undefined) return undefined;
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Read two simple declarations from the raw attribute, keeping token offsets. */
export function readInlineContrast(attribute: string) {
  const style = /^(style[\t\r\n\f ]*=[\t\r\n\f ]*)(["'])([\s\S]*)\2$/i.exec(attribute);
  if (!style) return undefined;

  let offset = style[1]!.length + 1;
  let foreground: { value: string; offset: number } | undefined;
  let background: string | undefined;
  for (const declaration of style[3]!.split(";")) {
    const start = offset;
    offset += declaration.length + 1;
    if (/^[\t\r\n\f ]*$/.test(declaration)) continue;

    const match = /^([\t\r\n\f ]*(color|background-color)[\t\r\n\f ]*:[\t\r\n\f ]*)(#[\da-f]+)[\t\r\n\f ]*$/i.exec(declaration);
    if (!match) return undefined;
    const value = match[3]!;
    if (match[2]!.toLowerCase() === "color") {
      if (foreground) return undefined;
      foreground = { value, offset: start + match[1]!.length };
    } else {
      if (background) return undefined;
      background = value;
    }
  }

  if (!foreground || !background) return undefined;
  const ratio = contrastRatio(foreground.value, background);
  if (ratio !== undefined) return { foreground, background, ratio };
}
