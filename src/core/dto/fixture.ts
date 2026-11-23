/** JSON 形态的脱敏夹具正文。数值、字符串与 null 分开保留。 */
export type SanitizedJson =
  | null
  | boolean
  | number
  | string
  | readonly SanitizedJson[]
  | { readonly [key: string]: SanitizedJson };
