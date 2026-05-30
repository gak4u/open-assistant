import { z } from "zod";

export const EntityTypes = [
  "person",
  "place",
  "project",
  "event",
  "organization",
  "fact",
  "topic",
  "artifact",
] as const;

export type EntityType = (typeof EntityTypes)[number];

export const RelationTypes = [
  "worked_on",
  "mentioned",
  "related_to",
  "happened_at",
  "located_in",
  "knows",
  "owns",
  "part_of",
  "depends_on",
  "produced",
] as const;

export type RelationType = (typeof RelationTypes)[number];

export const Entity = z.object({
  id: z.string(),
  type: z.enum(EntityTypes),
  name: z.string(),
  description: z.string().optional(),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
});
export type Entity = z.infer<typeof Entity>;

export const Relation = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(RelationTypes),
  context: z.string().optional(),
  weight: z.number().optional(),
  created_at: z.number().optional(),
});
export type Relation = z.infer<typeof Relation>;

export const Turn = z.object({
  id: z.string(),
  session_id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  created_at: z.number(),
});
export type Turn = z.infer<typeof Turn>;

export const ExtractionResult = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.enum(EntityTypes),
      description: z.string().optional(),
    }),
  ),
  relations: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      type: z.enum(RelationTypes),
      context: z.string().optional(),
    }),
  ),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 96);
}

export function entityId(type: EntityType, name: string): string {
  return `${type}:${slugify(name)}`;
}
