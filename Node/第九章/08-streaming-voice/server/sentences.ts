/** 缓存不完整的句子；按中文句末标点分段，避免把 1599.00 的小数点当句末。 */
export class SentenceBuffer {
  private pending = ''
  push(delta: string): string[] {
    this.pending += delta
    const sentences: string[] = []
    let match: RegExpExecArray | null
    while ((match = /[。！？；\n]/u.exec(this.pending))) {
      const end = match.index + match[0].length
      const sentence = this.pending.slice(0, end).trim()
      this.pending = this.pending.slice(end)
      if (sentence) sentences.push(sentence)
    }
    if (this.pending.length > 500) throw new Error('回答单句过长，已停止合成，请缩短问题')
    return sentences
  }
  flush() { const tail = this.pending.trim(); this.pending = ''; return tail ? [tail] : [] }
}
