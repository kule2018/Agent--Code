import type { Brief, Characters, Outline, Review, World } from './contracts.js'
import type { Scene } from '../../shared/engine.js'

export const replayBrief: Brief = {
  title: '失联太空站',
  premise: '太空站与地球失去联系。最后的电池只能支撑一个主要系统，工程师林澜必须在有限时间内决定如何让大家活下去。',
  genre: '科幻悬疑',
  audience: '喜欢选择与悬疑故事的玩家',
  worldRules: '太空站无法恢复对外通信，也无法获得外部救援。剩余电量只能支持一个高耗能系统。',
  characterCount: 3, sceneCount: 8, endingCount: 3,
  mode: 'replay', replayScenario: 'normal'
}

export const replayWorld: World = {
  title: '失联太空站',
  summary: '一次通信事故以后，太空站与地球彻底失联。船员只有最后一组电池和逐渐耗尽的物资，任何生存方案都必须付出明确代价。',
  rules: [
    '太空站无法恢复对外通信，也无法获得外部救援。',
    '最后一组电池只够维持一个高耗能系统。',
    '工程师林澜必须依靠站内人员、设备和物资解决问题。'
  ]
}

export const replayCharacters: Characters = { characters: [
  { id: 'lin-lan', name: '林澜', goal: '让船员在有限物资中活下去', motivation: '作为工程师，她要对每一次用电决策负责。' },
  { id: 'zhou-ming', name: '周明', goal: '守住损坏的空气循环系统', motivation: '他知道清醒维修意味着更快消耗食物。' },
  { id: 'su-ya', name: '苏雅', goal: '稳定船员情绪并保留医疗资源', motivation: '她不愿让休眠成为逃避风险的借口。' }
] }

export const replayOutline: Outline = {
  title: '失联太空站：最后一组电池', startSceneId: 'scene-01',
  flags: { hasKey: false, trustedEngineer: false },
  scenes: [
    { id: 'scene-01', summary: '林澜发现电池只够一个系统。玩家在工程维修和稳定船员之间选择，前面的决定会改变后续可用路径。', characterIds: ['lin-lan', 'zhou-ming', 'su-ya'], ending: false, choices: [
      { id: 'repair', text: '领取维修授权卡，跟周明去机舱', to: 'scene-02', when: {}, effects: { hasKey: true } },
      { id: 'medical', text: '陪苏雅守住休眠舱，稳定船员', to: 'scene-03', when: {}, effects: { trustedEngineer: true } }
    ] },
    { id: 'scene-02', summary: '在机舱确认空气循环系统的损坏，决定调查控制室，或者深入反应堆寻找另一种留在站内的办法。', characterIds: ['lin-lan', 'zhou-ming'], ending: false, choices: [
      { id: 'control', text: '去控制室核对剩余电量', to: 'scene-04', when: {}, effects: {} },
      { id: 'reactor', text: '去反应堆寻找替代方案', to: 'scene-05', when: {}, effects: {} }
    ] },
    { id: 'scene-03', summary: '在休眠舱确认医疗储备，决定调查控制室，或者向周明请教反应堆的真实状况。', characterIds: ['lin-lan', 'su-ya'], ending: false, choices: [
      { id: 'control', text: '独自去控制室查看记录', to: 'scene-04', when: {}, effects: {} },
      { id: 'consult', text: '请周明一同检查反应堆', to: 'scene-05', when: {}, effects: {} }
    ] },
    { id: 'scene-04', summary: '控制室有一条需要授权卡的维修指令。没有授权卡时仍可选择按计划休眠，两个后果都只依靠站内资源。', characterIds: ['lin-lan', 'zhou-ming'], ending: false, choices: [
      { id: 'restart', text: '用授权卡重启空气循环', to: 'ending-01', when: { hasKey: true }, effects: {} },
      { id: 'sleep', text: '把电量留给休眠舱', to: 'ending-02', when: {}, effects: {} }
    ] },
    { id: 'scene-05', summary: '反应堆维护需要另一名工程师配合。此前得到同伴信任才有机会合作，否则只能依靠休眠保留物资。', characterIds: ['lin-lan', 'zhou-ming'], ending: false, choices: [
      { id: 'team', text: '与周明合作修复供电', to: 'ending-03', when: { trustedEngineer: true }, effects: {} },
      { id: 'sleep', text: '封闭反应堆，转入休眠', to: 'ending-02', when: {}, effects: {} }
    ] },
    { id: 'ending-01', summary: '维持清醒维修，代价是食物消耗更快；太空站仍然无法联系外界。', characterIds: ['lin-lan', 'zhou-ming'], ending: true, choices: [] },
    { id: 'ending-02', summary: '用电量换取休眠时间，代价是维修停滞；没有外部救援。', characterIds: ['lin-lan', 'su-ya'], ending: true, choices: [] },
    { id: 'ending-03', summary: '依靠船员合作稳定供电，代价是拆掉站内备用系统；结局仍由站内人员承担。', characterIds: ['lin-lan', 'zhou-ming'], ending: true, choices: [] }
  ]
}

/** Replay 只演示有限的修改意见，仍然返回真实变化的大纲文件。 */
export function replayRevisedOutline(feedback: string): Outline {
  if (/代价/.test(feedback)) {
    return { ...replayOutline, scenes: replayOutline.scenes.map((scene) => scene.id === 'ending-01'
      ? { ...scene, summary: '修复空气循环以后，船员保住清醒维修的机会；食物消耗加快，而且所有设备都只能由站内人员维护。' }
      : scene) }
  }
  if (/悬疑|紧张/.test(feedback)) {
    return { ...replayOutline, scenes: replayOutline.scenes.map((scene) => scene.id === 'scene-03'
      ? { ...scene, summary: '休眠舱忽然传来断续的敲击声。苏雅检查医疗储备，船员情绪越来越紧张，玩家必须决定如何调查下一步。' }
      : scene) }
  }
  throw new Error('Replay 只演示“明确结局代价”或“增加悬疑感”的大纲修改；自定义要求请使用 AI 模式。')
}

const prose: Record<string, { title: string; content: string }> = {
  'scene-01': { title: '最后一组电池', content: '红色警报沿着舱壁闪烁。工程师林澜打开电量清单：最后一组电池只能维持一个高耗能系统。周明要修空气循环，苏雅则希望先稳定休眠舱里的船员。你必须决定先相信谁。' },
  'scene-02': { title: '机舱里的裂缝', content: '机舱里传来金属摩擦的声响。周明指出空气循环系统的裂缝，维修授权卡已经交到你手里。你们能继续查控制室的剩余电量，也能冒险去反应堆寻找替代供电。' },
  'scene-03': { title: '安静的休眠舱', content: '苏雅把医疗物资逐件放入密封柜。船员终于平静下来，但每多开一盏灯都会缩短剩余时间。你可以独自前往控制室，也可以请周明一起查看反应堆。' },
  'scene-04': { title: '控制室的指令', content: '终端留着一条修复空气循环的紧急指令，启动它需要维修授权卡。你盯着电量读数，知道哪怕修好系统，食物也会更快耗尽。另一条路是把电量留给休眠。' },
  'scene-05': { title: '反应堆的微光', content: '反应堆里还有一点微弱供电，拆掉备用系统也许能维持主要设备。但周明必须愿意和你一起冒险。你还可以封闭反应堆，带着船员进入漫长的休眠。' },
  'ending-01': { title: '清醒的守望', content: '林澜启动空气循环系统，船员轮班维修，不再使用休眠舱。大家保住了清醒工作的机会，却必须面对更快的食物消耗。太空站依然与外界隔绝，后面的每一天都需要自己争取。' },
  'ending-02': { title: '沉睡的长夜', content: '林澜把最后的电量留给休眠舱，船员的消耗慢了下来，维修也随之停滞。没有任何外部救援会到来；大家只能依靠站内设备和储备，等待下一次醒来时自己作出选择。' },
  'ending-03': { title: '拆下备用系统', content: '林澜和周明一起拆掉备用系统，用回收的零件维持主要设备。船员暂时获得了清醒维修的时间，但再没有第二套设备可供替换。他们守住了一线希望，也承担了全部故障风险。' }
}

export const defectQuote = '林澜恢复了对外通信，成功联系地球，救援飞船赶到并接走了所有人。'

export function replayScenes(defect: boolean): Scene[] {
  return replayOutline.scenes.map((item) => ({
    id: item.id, title: prose[item.id].title,
    content: defect && item.id === 'ending-02'
      ? `林澜让大家进入休眠，维修暂时停止。${defectQuote}`
      : prose[item.id].content,
    ending: item.ending, choices: item.choices
  }))
}

export function replayReport(defect: boolean): Review {
  return defect ? {
    verdict: 'needs_revision', issues: [{
      filePath: '/scenes/ending-02.json', rule: replayWorld.rules[0], quote: defectQuote,
      reason: '这个结局依靠对外通信和救援飞船解决困境，违反失联世界规则。',
      suggestion: '去掉外部救援，保留休眠降低消耗和维修停滞的代价。'
    }]
  } : { verdict: 'approved', issues: [] }
}

export function replayRevisedScene(sceneId: string, instruction?: string): Scene {
  const base = replayScenes(false).find((item) => item.id === sceneId)
  if (!base) throw new Error(`Replay 没有场景 ${sceneId}。`)
  if (instruction && !/紧张|悬疑|压迫|对话|细节|更简洁/.test(instruction)) {
    throw new Error('Replay 只演示固定场景的表达调整；自定义要求请使用 AI 模式。')
  }
  if (!instruction) return base
  return {
    ...base,
    title: base.title,
    content: `警报声一遍遍撞向舱壁，林澜看见每个人都在等她作出决定。${base.content}她把话压低，说出这个选择的代价。`
  }
}
