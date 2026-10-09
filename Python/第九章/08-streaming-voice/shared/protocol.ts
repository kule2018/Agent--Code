export type Mode = 'stream' | 'buffered'
export interface Packet { event: string; data: { turnId: string; [key: string]: any } }
export const questionExample = '仅按已导入记录，2026 年 9 月各区域的未扣退款销售额分别是多少？'
