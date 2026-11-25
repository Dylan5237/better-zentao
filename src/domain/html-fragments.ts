const attributes = String.raw`(?:[^"'<>]|"[^"]*"|'[^']*')*`;
export const htmlFragments = new RegExp(
  [
    String.raw`<!--[\s\S]*?(?:-->|$)`,
    String.raw`<(script|style|textarea|title|template|pre|code)(?=[\s/>])${attributes}>[\s\S]*?(?:</\1\s*>|$)`,
    String.raw`<p(?=[\s>])${attributes}>\s*(?<footer>\[bzt:(?:v1\s+[^[\]\r\n<>]*|stage=[a-z]+)\])\s*</p\s*>`,
    String.raw`</?[a-z][a-z\d:-]*${attributes}(?:>|"[^"]*$|'[^']*$)`,
    String.raw`[^<]+|<`,
  ].join("|"),
  "giu",
);
