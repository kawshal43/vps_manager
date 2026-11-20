import { z } from 'zod'

export const appIds = [
  'files',
  'terminal',
  'server',
  'applications',
  'transfers',
  'settings',
] as const
export type AppId = (typeof appIds)[number]
export const boundsSchema = z
  .object({
    x: z.number().finite().min(0).max(20000),
    y: z.number().finite().min(0).max(20000),
    width: z.number().finite().min(320).max(20000),
    height: z.number().finite().min(220).max(20000),
  })
  .strict()
export type Bounds = z.infer<typeof boundsSchema>
export const workspaceSchema = z
  .object({
    version: z.literal(1),
    pinned: z.array(z.enum(appIds)).max(6),
    windows: z
      .array(
        z
          .object({
            scope: z.string().min(1).max(600),
            app: z.enum(appIds),
            bounds: boundsSchema,
            mode: z.enum(['normal', 'maximized', 'minimized']),
            restoreMode: z.enum(['normal', 'maximized']).default('normal'),
            open: z.boolean(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .refine(
    (value) => new Set(value.pinned).size === value.pinned.length,
    'Pinned apps must be unique.',
  )
  .refine(
    (value) =>
      new Set(value.windows.map((w) => JSON.stringify([w.scope, w.app]))).size ===
      value.windows.length,
    'Saved app windows must be unique within a server workspace.',
  )
export type WorkspaceLayout = z.infer<typeof workspaceSchema>
export const defaultWorkspace = (): WorkspaceLayout => ({
  version: 1,
  pinned: ['files', 'terminal', 'server'],
  windows: [],
})

export function fitBounds(
  bounds: Bounds,
  area: { width: number; height: number },
  minimum = { width: 560, height: 350 },
): Bounds {
  const width = Math.min(Math.max(minimum.width, bounds.width), Math.max(320, area.width))
  const height = Math.min(Math.max(minimum.height, bounds.height), Math.max(220, area.height))
  return {
    width,
    height,
    x: Math.max(0, Math.min(bounds.x, area.width - width)),
    y: Math.max(0, Math.min(bounds.y, area.height - height)),
  }
}
