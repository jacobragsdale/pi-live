import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

/** Check a parsed value against a schema. Schemas set additionalProperties: false, so unknown keys fail. */
export function validate<const S extends TSchema>(schema: S, value: unknown, source: string): Static<S> {
  if (Check(schema, value)) {
    return value;
  }
  const [first] = Errors(schema, value);
  const where = first === undefined || first.instancePath === "" ? "/" : first.instancePath;
  throw new Error(`${source}: ${where} ${first?.message ?? "is invalid"}`);
}

/** Parse JSON text and validate it. */
export function parseJson<const S extends TSchema>(schema: S, text: string, source: string): Static<S> {
  const value: unknown = JSON.parse(text);
  return validate(schema, value, source);
}
