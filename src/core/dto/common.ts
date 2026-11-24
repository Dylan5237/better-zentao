import { z } from "zod";
import { civilDate, parseZentaoDateTime } from "../calendar.ts";

const idString = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform(Number);
const nullableIdSentinel = z.union([
  z.literal(0),
  z.literal("0"),
  z.literal(""),
  z.null(),
]);
const dateSentinel =
  /^(?:|0000-00-00(?:[ Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?)$/u;
const absoluteDateTime = z.iso.datetime({ offset: true });
const absoluteParts =
  /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/u;

export const zId = z.union([z.number(), idString]).pipe(z.int().positive());
export const zCount = z
  .union([z.number(), z.string().regex(/^\d+$/u).transform(Number)])
  .pipe(z.int().nonnegative());
export const zNullableId = z.union([
  zId,
  nullableIdSentinel.transform(() => null),
]);
export const zParentPlanId = z.union([
  zNullableId,
  z.union([z.literal(-1), z.literal("-1")]).transform(() => -1 as const),
]);

export const zBool = z.union([
  z
    .union([z.literal(true), z.literal(1), z.literal("1"), z.literal("true")])
    .transform(() => true),
  z
    .union([
      z.literal(false),
      z.literal(0),
      z.literal("0"),
      z.literal("false"),
      z.literal(""),
    ])
    .transform(() => false),
]);

export const zAccount = z
  .union([
    z.string(),
    z.object({ account: z.string() }).transform(({ account }) => account),
    z.null(),
  ])
  .transform((account) => account?.trim() || null);

export const zHours = z.union([
  z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u)
        .transform(Number),
    ])
    .pipe(z.number().nonnegative()),
  z.union([z.literal(""), z.null()]).transform(() => null),
]);

export const zDate = z.union([
  civilDate,
  z
    .string()
    .regex(dateSentinel)
    .transform(() => null),
  z.null(),
]);

export function dateTimeSchema(timezone?: string) {
  return z
    .string()
    .nullable()
    .transform((value, context): number | null => {
      if (value === null || dateSentinel.test(value)) return null;
      try {
        const absolute = absoluteParts.exec(value);
        const wallTime = absolute?.[1];
        const zone = absolute?.[3];
        if (
          wallTime !== undefined &&
          zone !== undefined &&
          absoluteDateTime.safeParse(value.replace(/z$/u, "Z")).success
        ) {
          const whole = parseZentaoDateTime(wallTime, "UTC");
          if (whole === null) return null;
          const fraction = Number(
            (absolute?.[2] ?? "").padEnd(3, "0").slice(0, 3),
          );
          const minutes =
            zone.toUpperCase() === "Z"
              ? 0
              : Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4));
          return (
            whole +
            fraction -
            (zone.startsWith("-") ? -minutes : minutes) * 60_000
          );
        }
        return parseZentaoDateTime(value, timezone);
      } catch {
        context.addIssue({ code: "custom", message: "禅道日期时间不合法。" });
        return z.NEVER;
      }
    });
}

export const zDateTime = dateTimeSchema();

export function parsePlanIds(
  value: string | number | null | undefined,
): number[] {
  if (value == null || value === 0) return [];
  if (typeof value === "number") return [zId.parse(value)];
  return z.array(zId).parse(
    value
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "" && id !== "0"),
  );
}

export function zCollection<T>(item: z.ZodType<T>, positiveKeys = false) {
  const key = z
    .string()
    .regex(positiveKeys ? /^[1-9]\d*$/u : /^(?:0|[1-9]\d*)$/u);
  return z.union([
    z.array(item),
    z.record(key, item).transform((records) => Object.values(records)),
  ]);
}

function defineDtoBrand<K extends symbol>(
  value: object,
  key: K,
): asserts value is Readonly<Record<K, true>> {
  Object.defineProperty(value, key, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

export function brandDto<T extends object, K extends symbol>(
  value: T,
  key: K,
): T & Readonly<Record<K, true>> {
  const branded = { ...value };
  defineDtoBrand(branded, key);
  return branded;
}
