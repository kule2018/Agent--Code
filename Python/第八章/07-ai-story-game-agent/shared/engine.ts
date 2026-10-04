export type Flags = Record<string, boolean>
export type Choice = { id: string; text: string; to: string; when: Flags; effects: Flags }
export type Scene = { id: string; title: string; content: string; ending: boolean; choices: Choice[] }
export type Character = { id: string; name: string; goal: string; motivation: string }
export type Game = {
  title: string
  premise: string
  startSceneId: string
  flags: Flags
  characters: Character[]
  scenes: Scene[]
}
export type Session = {
  sceneId: string
  flags: Flags
  history: { sceneId: string; choiceId: string }[]
}

export function startGame(game: Game): Session {
  return { sceneId: game.startSceneId, flags: { ...game.flags }, history: [] }
}

export function currentScene(game: Game, session: Session): Scene {
  const scene = game.scenes.find((item) => item.id === session.sceneId)
  if (!scene) throw new Error(`场景不存在：${session.sceneId}`)
  return scene
}

export function availableChoices(scene: Scene, flags: Flags): Choice[] {
  return scene.choices.filter((choice) =>
    Object.entries(choice.when).every(([key, value]) => flags[key] === value)
  )
}

export function choose(game: Game, session: Session, choiceId: string): Session {
  const scene = currentScene(game, session)
  const choice = availableChoices(scene, session.flags).find((item) => item.id === choiceId)
  if (!choice) throw new Error('这个选项当前不可选。')
  if (!game.scenes.some((item) => item.id === choice.to)) throw new Error(`选项目标不存在：${choice.to}`)
  return {
    sceneId: choice.to,
    flags: { ...session.flags, ...choice.effects },
    history: [...session.history, { sceneId: scene.id, choiceId }]
  }
}
