import { Type, type TObject, type TSchema, type TUnion } from "typebox";

// OpenAI-compatible servers (LM Studio) reject a bare-anyOf root and show the model only root
// `properties`, so the merged fields are exposed there; anyOf still validates each action strictly.
export function ActionUnion<const Members extends TObject[]>(members: [...Members]): TUnion<Members> {
  const actions: string[] = [];
  const variants = new Map<string, TSchema[]>();
  for (const member of members) {
    for (const [key, schema] of Object.entries(member.properties)) {
      if (key === "action") {
        actions.push((schema as { const: string }).const);
        continue;
      }
      const { "~optional": _optional, ...plain } = schema as TSchema & { "~optional"?: boolean };
      const seen = variants.get(key) ?? [];
      if (!seen.some((existing) => JSON.stringify(existing) === JSON.stringify(plain))) seen.push(plain);
      variants.set(key, seen);
    }
  }
  const properties: Record<string, unknown> = { action: { type: "string", enum: actions } };
  for (const [key, seen] of variants) properties[key] = seen.length === 1 ? seen[0] : { anyOf: seen };
  return Type.Union(members, { type: "object", properties, required: ["action"] });
}
