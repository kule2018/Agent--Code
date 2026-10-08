/** 对上一节已经汇总的区域金额计算占比，金额先转为整数分。 */
export default function analyze(rows) {
  const amounts = rows.map((row) => BigInt(row.sales_amount.replace('.', '')))
  const total = amounts.reduce((sum, amount) => sum + amount, 0n)
  return {
    rows: rows.map((row, index) => {
      // 百分比保留两位小数；只处理本例的非负、两位小数金额。
      const scaled = total === 0n ? null : (amounts[index] * 10000n + total / 2n) / total
      const share = scaled === null ? null : `${scaled / 100n}.${String(scaled % 100n).padStart(2, '0')}`
      return { region: row.region, sales_amount: row.sales_amount, share_percent: share }
    })
  }
}
