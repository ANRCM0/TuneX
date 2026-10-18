/**
 * packages/shared/src/telegram.ts
 *
 * Evidence: relayx-analysis/work/shared/005__packages__shared__src__telegram.ts:1-35
 *
 * MarkdownV2 escaping. The character set is reproduced exactly, including `.`, `!`
 * and `-` which the Telegram spec only requires inside certain contexts.
 */
const SPECIAL_CHARS = [
  "\\",
  "_",
  "*",
  "[",
  "]",
  "(",
  ")",
  "~",
  "`",
  ">",
  "<",
  "&",
  "#",
  "+",
  "-",
  "=",
  "|",
  "{",
  "}",
  ".",
  "!"
];

export const escapeMarkdown = (text: string): string => {
  SPECIAL_CHARS.forEach((char) => (text = text.replaceAll(char, `\\${char}`)));
  return text;
};
