// 离线 HTML 中使用的固定引擎；规则与 engine.ts / engine.py 一致。
const StoryEngine = (() => {
  function startGame(game) {
    return { sceneId: game.startSceneId, flags: { ...game.flags }, history: [] }
  }
  function currentScene(game, session) {
    const scene = game.scenes.find(item => item.id === session.sceneId)
    if (!scene) throw new Error(`场景不存在：${session.sceneId}`)
    return scene
  }
  function availableChoices(scene, flags) {
    return scene.choices.filter(choice => Object.entries(choice.when).every(([key, value]) => flags[key] === value))
  }
  function choose(game, session, choiceId) {
    const scene = currentScene(game, session)
    const choice = availableChoices(scene, session.flags).find(item => item.id === choiceId)
    if (!choice) throw new Error('这个选项当前不可选。')
    if (!game.scenes.some(item => item.id === choice.to)) throw new Error(`选项目标不存在：${choice.to}`)
    return { sceneId: choice.to, flags: { ...session.flags, ...choice.effects },
      history: [...session.history, { sceneId: scene.id, choiceId }] }
  }
  return { startGame, currentScene, availableChoices, choose }
})()
