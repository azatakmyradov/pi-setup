import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Plain-text themer for panel tests: the panels only call `fg`, `bold`,
 * `italic`, and `inverse`, and the assertions compare uncolored output.
 */
// SAFETY: test double covering the four styling calls the panels make.
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  inverse: (text: string) => text,
} as Theme;

export { plainTheme };
