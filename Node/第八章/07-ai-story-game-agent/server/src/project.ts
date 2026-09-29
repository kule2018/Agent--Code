import type { Brief, Characters, Outline, Review, World } from './contracts.js'

export type ProjectStatus =
  | 'queued' | 'designing_world' | 'designing_outline' | 'awaiting_outline_review'
  | 'writing_scenes' | 'reviewing' | 'needs_human_review' | 'ready' | 'failed' | 'cancelled'

export type Project = {
  id: string
  version: number
  revision: number
  runId: string
  mode: 'replay' | 'ai'
  status: ProjectStatus
  brief: Brief
  world: World | null
  characters: Characters | null
  outline: Outline | null
  outlineVersion: number
  approvedOutlineVersion: number | null
  review: Review | null
  repairCount: number
  latestReleaseId: string | null
  releaseIds: string[]
  failure: string | null
  activeRole: string | null
  currentTask: string | null
  tasks: { id: string; role: string; status: 'running' | 'completed' | 'failed'; inputs: string[]; outputs: string[]; error?: string }[]
  createdAt: string
  updatedAt: string
}

export type ProjectEvent = {
  id: number
  projectId: string
  kind: string
  message: string
  detail: Record<string, unknown>
  createdAt: string
}
